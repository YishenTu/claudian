import type { TFile, ViewStateResult, WorkspaceLeaf } from 'obsidian';
import { ItemView, Notice, Scope, setIcon } from 'obsidian';

import { StartupProfiler } from '@/core/performance/StartupProfiler';
import { getHiddenCommandSet } from '@/core/providers/commands/hiddenCommands';
import { DEFAULT_CHAT_PROVIDER_ID, type ProviderId } from '@/core/providers/types';
import { VIEW_TYPE_CLAUDIAN } from '@/core/types';
import type { ChatFeatureHost } from '@/features/chat/ChatFeatureHost';
import { SessionManagerSurface, setControlAvailability } from '@/features/chat/session-manager/SessionManagerSurface';
import { SessionNavigation } from '@/features/chat/session-manager/SessionNavigation';
import type { ChatTab, TabId } from '@/features/chat/tabs/ChatTab';
import { TabWorkspaceLifecycle } from '@/features/chat/tabs/persistence/TabWorkspaceLifecycle';
import { getTabProviderId } from '@/features/chat/tabs/providerResolution';
import { TabBar } from '@/features/chat/tabs/TabBar';
import {
  cancelSelectedDestinationTurn,
  sendTabInputMessageFromExplicitEnterShortcut,
} from '@/features/chat/tabs/TabInputEvents';
import { TabManager } from '@/features/chat/tabs/TabManager';
import type { AssembledTabRuntime } from '@/features/chat/tabs/types';
import {
  cancelScheduledAnimationFrame,
  scheduleAnimationFrame,
  type ScheduledAnimationFrame,
} from '@/features/chat/utils/animationFrame';
import { ChatPresentationPlacement } from '@/features/chat/view/ChatPresentationPlacement';
import { DualPaneLayout, type DualPaneLayoutElements } from '@/features/chat/view/DualPaneLayout';
import type { ZenModeSlots, ZenModeSource, ZenPresentationPort } from '@/features/chat/zen/types';
import { VaultMentionDataProvider } from '@/shared/mention/VaultMentionDataProvider';

type LoadableView = {
  containerEl?: HTMLElement;
  load: () => Promise<void> | void;
};

export class ClaudianView extends ItemView implements ZenModeSource {
  private plugin: ChatFeatureHost;

  // Tab management
  private tabManager: TabManager | null = null;
  private tabBar: TabBar | null = null;
  private tabBarContainerEl: HTMLElement | null = null;
  private tabContentEl: HTMLElement | null = null;
  private newTabButtonEl: HTMLElement | null = null;
  private viewContainerEl: HTMLElement | null = null;
  private readonly mentionDataProvider: VaultMentionDataProvider;
  private releaseMentionCacheEvents: (() => void) | null = null;

  // Zen mode source; placement stays with this view's presentation owner.
  private zenPresentationListeners = new Set<() => void>();
  private zenSourceRegistration: (() => void) | null = null;

  // Debouncing for tab bar updates
  private pendingTabBarUpdate: ScheduledAnimationFrame | null = null;
  private readonly tabWorkspace: TabWorkspaceLifecycle;
  private readonly sessionNavigation: SessionNavigation;
  private readonly sessions: SessionManagerSurface;
  private readonly layout: DualPaneLayout;
  private readonly presentation: ChatPresentationPlacement;

  constructor(leaf: WorkspaceLeaf, plugin: ChatFeatureHost) {
    super(leaf);
    this.plugin = plugin;
    this.mentionDataProvider = new VaultMentionDataProvider(plugin.app);
    this.tabWorkspace = this.createTabWorkspace();
    this.sessionNavigation = new SessionNavigation({
      plugin,
      view: this,
      getTabManager: () => this.tabManager,
      createNewTab: () => this.createNewTab(),
      onTabsChanged: () => this.updateTabBarVisibility(),
    });
    this.sessions = new SessionManagerSurface({
      plugin,
      navigation: this.sessionNavigation,
      getActiveTab: () => this.getActiveTab(),
      isWide: () => this.layout.isWide,
      canCreateTab: () => this.tabManager?.canCreateTab() ?? null,
      requestNew: () => this.requestDualNew(),
      notifyOtherViews: () => this.notifyOtherViews(),
    });
    this.layout = new DualPaneLayout({
      getSettings: () => this.plugin.settings,
      onWideChanged: () => this.presentation.updateChip(),
      onEnterWide: () => this.sessions.enterWide(),
      renderSidebar: () => this.sessions.renderSidebar(),
      onLeaveWideRequested: () => this.sessions.leaveWide(),
      discardProvisionalTabs: () => {
        // Pinned previews are retained synchronously before the cleanup can close them.
        this.sessionNavigation.retainPinnedProvisionalTabs();
        return this.tabManager?.discardProvisionalTabs();
      },
    });
    this.presentation = new ChatPresentationPlacement({
      getActiveTab: () => this.getActiveTab(),
      getTab: tabId => this.tabManager?.getTab(tabId) ?? null,
      isWide: () => this.layout.isWide,
      getTabCount: () => this.tabManager?.getTabCount() ?? null,
    });

    // Hover Editor compatibility: Define load as an instance method that can't be
    // overwritten by prototype patching. Hover Editor patches ClaudianView.prototype.load
    // after our class is defined, but instance methods take precedence over prototype methods.
    const prototype = Object.getPrototypeOf(this) as LoadableView;
    const originalLoad = prototype.load.bind(this);
    Object.defineProperty(this, 'load', {
      value: async () => {
        // Ensure containerEl exists before any patched load code tries to use it
        if (!this.containerEl) {
          (this as LoadableView).containerEl = createDiv({ cls: 'view-content' });
        }
        // Wrap in try-catch to prevent Hover Editor errors from breaking our view
        try {
          return await originalLoad();
        } catch {
          // Hover Editor may throw if its DOM setup fails - continue anyway
        }
      },
      writable: false,
      configurable: false,
    });
  }

  getViewType(): string {
    return VIEW_TYPE_CLAUDIAN;
  }

  getDisplayText(): string {
    return 'Claudian';
  }

  getIcon(): string {
    return 'bot';
  }

  getState(): Record<string, unknown> {
    return this.tabWorkspace.getState();
  }

  async setState(state: unknown, _result: ViewStateResult): Promise<void> {
    await this.tabWorkspace.setState(state);
  }

  private createTabWorkspace(): TabWorkspaceLifecycle {
    return new TabWorkspaceLifecycle({
      getPlugin: () => this.plugin,
      view: this,
      getTabManager: () => this.tabManager,
      getTabBar: () => this.tabBar,
      isWideLayout: () => this.layout.isWide,
      onInitialized: () => {
        this.syncProviderBrandColor();
        this.presentation.update();
        this.updateTabBar();
        this.notifyConversationNavigationChanged();
        this.layout.startObserving();
        this.notifyZenPresentationChanged();
      },
    });
  }

  /** Refreshes model-dependent UI across all tabs (used after settings/env changes). */
  refreshModelSelector(changedProviderId?: ProviderId): void {
    this.tabManager?.reconcileProviderAvailability();
    for (const tab of this.tabManager?.getAllTabs() ?? []) {
      const providerId = getTabProviderId(tab, this.plugin);
      if (
        changedProviderId
        && tab.conversationId !== null
        && providerId !== changedProviderId
      ) {
        continue;
      }
      tab.refreshProviderControls();
    }
  }

  invalidateProviderCommandCaches(providerIds?: ProviderId[]): void {
    this.tabManager?.invalidateProviderCommandCaches(providerIds);
  }

  invalidateProviderResources(providerIds: ProviderId[], generation: number): void {
    this.tabManager?.invalidateProviderResources(providerIds, generation);
  }

  /** Updates hidden commands on all tabs after settings changes. */
  updateHiddenCommands(): void {
    const hiddenCommands = getHiddenCommandSet(this.plugin.settings);
    for (const tab of this.tabManager?.getAllTabs() ?? []) {
      tab.composer.setHiddenCommands(hiddenCommands);
    }
  }

  async onOpen() {
    const span = StartupProfiler.start('view-open');
    try {
      await this.onOpenImpl();
    } finally {
      StartupProfiler.finish(span);
    }
  }

  private async onOpenImpl() {
    const opening = this.tabWorkspace.beginOpen();
    const lifecycleRevision = opening.revision;

    // Guard: Hover Editor and similar plugins may call onOpen before DOM is ready.
    // containerEl must exist before we can access contentEl or create elements.
    if (!this.containerEl) {
      return;
    }

    // Use contentEl (standard Obsidian API) as primary target.
    // Hover Editor and other plugins may modify the DOM structure,
    // so we need fallbacks to handle non-standard scenarios.
    let container: HTMLElement | null =
      this.contentEl ?? (this.containerEl.children[1] as HTMLElement | null);

    if (!container) {
      // Last resort: create our own container inside containerEl
      container = this.containerEl.createDiv();
    }

    this.viewContainerEl = container;
    this.viewContainerEl.empty();
    this.viewContainerEl.addClass('claudian-container');

    const layoutElements = this.buildViewLayout(this.viewContainerEl);
    if (!this.tabContentEl) return;
    // Measure before restoration so restored tabs and the nav row see the final layout.
    this.layout.initialize(layoutElements);
    this.attachNavRowContentToInputFooter(this.buildNavRowContent());

    const tabStatePersistence = await this.tabWorkspace.preparePersistence(opening);
    if (!tabStatePersistence) return;

    const isTabWorkspaceInitialized = (): boolean => this.tabWorkspace.isInitialized(lifecycleRevision);
    const persist = (): void => this.tabWorkspace.persist(tabManager, tabStatePersistence);
    const refreshActiveTabPresentationIfInitialized = (): void => {
      if (!isTabWorkspaceInitialized()) return;
      this.updateTabBar();
      this.notifyConversationNavigationChanged();
      this.presentation.update();
      this.syncProviderBrandColor();
    };
    const tabManager = new TabManager(
      this.plugin,
      this.tabContentEl,
      this,
      {
        shouldForkToNewTab: () => this.layout.isWide,
        onTabCreated: () => {
          refreshActiveTabPresentationIfInitialized();
          persist();
        },
        onActiveTabChanged: () => {
          refreshActiveTabPresentationIfInitialized();
        },
        onActiveTabCommitted: () => {
          persist();
        },
        onTabSwitched: refreshActiveTabPresentationIfInitialized,
        onTabClosed: () => {
          if (isTabWorkspaceInitialized()) {
            this.updateTabBar();
            this.notifyConversationNavigationChanged();
            this.presentation.update();
            this.notifyZenPresentationChanged();
          }
          persist();
        },
        onTabStreamingChanged: () => {
          if (isTabWorkspaceInitialized()) {
            this.updateTabBar();
            this.notifyConversationNavigationChanged();
          }
        },
        onTabRewindingChanged: () => {
          if (isTabWorkspaceInitialized()) this.updateTabBar();
        },
        onTabTitleChanged: () => {
          if (isTabWorkspaceInitialized()) this.updateTabBar();
        },
        onTabWorkChanged: () => {
          if (isTabWorkspaceInitialized()) {
            this.updateTabBar();
            this.notifyConversationNavigationChanged();
          }
        },
        onTabAttentionChanged: () => {
          if (isTabWorkspaceInitialized()) {
            this.updateTabBar();
            this.notifyConversationNavigationChanged();
          }
        },
        onTabConversationChanged: () => {
          if (
            this.tabManager === tabManager
            && this.tabWorkspace.isCurrent(lifecycleRevision)
            && isTabWorkspaceInitialized()
          ) {
            this.updateTabBar();
            this.notifyConversationNavigationChanged();
            this.syncProviderBrandColor();
          }
          persist();
        },
        onTabDraftChanged: () => {
          persist();
        },
        onTabProviderChanged: () => {
          if (isTabWorkspaceInitialized()) {
            this.updateTabBar();
            this.syncProviderBrandColor();
          }
        },
      },
      this.mentionDataProvider,
    );
    this.tabManager = tabManager;
    this.releaseMentionCacheEvents?.();
    this.releaseMentionCacheEvents = this.mentionDataProvider.register(this.plugin.app.vault);
    this.mentionDataProvider.initializeInBackground();

    this.wireEventHandlers();
    this.startZenModeSource();
    await this.tabWorkspace.completeOpen(opening);
  }

  async onClose() {
    const lifecycleRevision = this.tabWorkspace.beginClose();
    // Zen presentation returns synchronously before asynchronous shutdown proceeds.
    this.stopZenModeSource();
    const tabManager = this.tabManager;
    const tabBar = this.tabBar;
    const scope = this.scope;
    const tabStatePersistence = this.tabWorkspace.currentPersistence;
    tabManager?.beginShutdown();
    // Supersedes any pending compact transition before shutdown awaits.
    this.layout.dispose();
    this.sessions.dispose();
    if (this.pendingTabBarUpdate !== null) {
      cancelScheduledAnimationFrame(this.pendingTabBarUpdate);
      this.pendingTabBarUpdate = null;
    }

    this.releaseMentionCacheEvents?.();
    this.releaseMentionCacheEvents = null;
    this.presentation.restoreAll();

    const shutdownSnapshot = this.tabWorkspace.snapshotForShutdown(
      tabManager,
      tabStatePersistence,
      tabBar,
    );
    try {
      await shutdownSnapshot;
      this.tabWorkspace.releaseClosedPersistence(lifecycleRevision, tabStatePersistence);
      if (this.tabManager === tabManager) this.tabManager = null;
      try {
        await tabManager?.destroy();
      } finally {
        if (this.tabManager === tabManager) this.tabManager = null;
        tabBar?.destroy();
        if (this.tabBar === tabBar) this.tabBar = null;
        if (this.scope === scope) this.scope = null;
      }
    } finally {
      this.tabWorkspace.settleShutdownSnapshot(shutdownSnapshot);
    }
  }

  prepareForPluginUnload(): Promise<void> {
    return this.tabWorkspace.prepareForPluginUnload();
  }

  // ============================================
  // UI Building
  // ============================================

  private buildViewLayout(containerEl: HTMLElement): DualPaneLayoutElements {
    const chatPanelEl = containerEl.createDiv({ cls: 'claudian-chat-panel' });
    this.tabContentEl = chatPanelEl.createDiv({ cls: 'claudian-tab-content-container' });
    this.presentation.mount(chatPanelEl);

    const resizerEl = containerEl.createDiv({ cls: 'claudian-session-resizer' });
    const sidebarEl = containerEl.createDiv({ cls: 'claudian-session-sidebar' });
    this.sessions.mountSidebar(sidebarEl);
    return { containerEl, resizerEl, sidebarEl };
  }

  /**
   * Builds the active tab nav row content.
   * The wrapper is moved to the active tab's nav row on tab switches.
   */
  private buildNavRowContent(): HTMLElement {
    const wrapper = this.containerEl.createDiv({ cls: 'claudian-input-nav-content' });

    this.tabBarContainerEl = wrapper.createDiv({ cls: 'claudian-tab-bar-container' });
    this.tabBar = new TabBar(this.tabBarContainerEl, {
      onTabClick: (tabId) => this.handleTabClick(tabId),
      onTabClose: (tabId) => {
        void this.handleTabClose(tabId);
      },
      onTitleExpansionChanged: () => this.tabWorkspace.persist(),
    });

    const navActionsEl = wrapper.createDiv({ cls: 'claudian-input-nav-actions' });

    this.newTabButtonEl = navActionsEl.createEl('button', {
      cls: 'claudian-input-nav-btn claudian-new-tab-btn',
      attr: { type: 'button' },
    });
    setIcon(this.newTabButtonEl, 'square-plus');
    this.newTabButtonEl.setAttribute('aria-label', 'New tab');
    this.newTabButtonEl.addEventListener('click', () => this.requestNewTab());

    const newBtn = navActionsEl.createEl('button', {
      cls: 'claudian-input-nav-btn claudian-new-conversation-btn',
      attr: { type: 'button' },
    });
    setIcon(newBtn, 'square-pen');
    newBtn.setAttribute('aria-label', 'New conversation');
    newBtn.addEventListener('click', () => this.requestNewConversation());

    this.sessions.mountHistoryControl(navActionsEl);

    return wrapper;
  }

  private attachNavRowContentToInputFooter(navRowContent: HTMLElement): void {
    this.tabBar?.captureScrollPosition();
    this.presentation.attachNavRow(navRowContent);
    this.tabBar?.restoreScrollPosition();
  }

  private requestNewTab(): void {
    void this.createNewTab().catch(() => new Notice('Failed to create tab'));
  }

  private requestNewConversation(): void {
    void (async () => {
      await this.tabManager?.createNewConversation();
      this.sessions.invalidate();
    })().catch(() => new Notice('Failed to create conversation'));
  }

  private requestDualNew(): void {
    void this.sessionNavigation.activateOrCreateDraftTab()
      .catch(() => new Notice('Failed to start a new conversation'));
  }

  async handleNewConversationCommand(): Promise<boolean> {
    if (!this.layout.isWide) return false;
    await this.sessionNavigation.activateOrCreateDraftTab();
    return true;
  }

  isDualPaneMode(): boolean {
    return this.layout.isWide;
  }

  refreshMessageTimestamps(): void {
    for (const tab of this.tabManager?.getAllTabs() ?? []) {
      tab.refreshMessageTimestamps();
    }
  }

  refreshDualPaneLayout(): void {
    if (!this.viewContainerEl) return;
    this.presentation.updateChip();
    this.layout.refresh();
  }

  /** Refreshes tab controls after settings that affect tab availability change. */
  refreshTabControls(): void {
    this.updateTabBarVisibility();
  }

  // ============================================
  // Tab Management
  // ============================================

  private handleTabClick(tabId: TabId): void {
    const switched = this.tabManager?.switchToTab(tabId);
    if (switched) {
      void switched.catch(() => new Notice('Failed to switch tab'));
    }
  }

  private async handleTabClose(tabId: TabId): Promise<void> {
    try {
      const tab = this.tabManager?.getTab(tabId);
      // Closing from the tab bar is an explicit interrupt of the foreground turn.
      const force = tab?.session.hasActiveTurn ?? false;
      await this.tabManager?.closeTab(tabId, force);
      this.updateTabBarVisibility();
    } catch {
      new Notice('Failed to close tab');
    }
  }

  async createNewTab(): Promise<AssembledTabRuntime | null> {
    const tab = await this.tabManager?.createTab();
    if (!tab) return null;
    this.updateTabBarVisibility();
    tab.composer.focus();
    return tab;
  }

  private updateTabBar(): void {
    if (!this.tabManager || !this.tabBar) return;

    // Debounce tab bar updates using requestAnimationFrame
    if (this.pendingTabBarUpdate !== null) {
      cancelScheduledAnimationFrame(this.pendingTabBarUpdate);
    }

    this.pendingTabBarUpdate = scheduleAnimationFrame(() => {
      this.pendingTabBarUpdate = null;
      if (!this.tabManager || !this.tabBar) return;

      const items = this.tabManager.getTabBarItems();
      this.tabBar.update(items);
      this.updateTabBarVisibility();
    }, this.containerEl.ownerDocument.defaultView ?? null);
  }

  private updateTabBarVisibility(): void {
    if (!this.tabBarContainerEl || !this.tabManager) return;

    this.tabBarContainerEl.toggleClass('claudian-hidden', this.tabManager.getTabCount() < 2);
    this.presentation.updateChip();
    this.updateNewTabButtonVisibility();
  }

  private updateNewTabButtonVisibility(): void {
    if (!this.tabManager) return;

    setControlAvailability(this.newTabButtonEl, this.tabManager.canCreateTab());
    this.sessions.refreshNewAvailability();
  }

  /** Sets `data-provider` on the root container so CSS brand color follows the active provider. */
  private syncProviderBrandColor(): void {
    if (!this.viewContainerEl) return;
    const providerId = this.resolveBrandProviderId();
    if (providerId) this.viewContainerEl.dataset.provider = providerId;
    else delete this.viewContainerEl.dataset.provider;
    this.notifyZenPresentationChanged();
  }

  private resolveBrandProviderId(): ProviderId | null {
    const activeTab = this.tabManager?.getActiveTab();
    return activeTab ? getTabProviderId(activeTab, this.plugin) : DEFAULT_CHAT_PROVIDER_ID;
  }

  // ============================================
  // Linked content events
  // ============================================

  private handleWorkspaceFileOpen(file: TFile | null): void {
    this.tabManager?.getActiveTab()?.linkedContent.handleActiveFileChanged(file, true);
  }

  private handleLinkedContentMetadataChanged(file: TFile | null): void {
    this.tabManager?.getActiveTab()?.linkedContent.handleActiveFileMetadataChanged(file);
  }

  handleLinkedContentRenamed(
    oldPath: string,
    newPath: string,
    includeDescendants: boolean,
  ): void {
    for (const tab of this.tabManager?.getAllTabs() ?? []) {
      tab.linkedContent.handleRenamed(oldPath, newPath, includeDescendants);
    }
  }

  handleLinkedContentDeleted(path: string, includeDescendants: boolean): void {
    for (const tab of this.tabManager?.getAllTabs() ?? []) {
      tab.linkedContent.handleDeleted(path, includeDescendants);
    }
  }

  handleLinkedContentCreated(path: string): void {
    for (const tab of this.tabManager?.getAllTabs() ?? []) {
      tab.linkedContent.handleCreated(path);
    }
  }

  // ============================================
  // Event Wiring
  // ============================================

  private wireEventHandlers(): void {
    const activeDocument = this.containerEl.ownerDocument;

    // Document-level click to close dropdowns
    this.registerDomEvent(activeDocument, 'click', () => {
      this.sessions.dismissDropdown();
    });

    // View scopes are the Obsidian-owned boundary for main-area tab hotkeys.
    // Returning false consumes Escape before Obsidian uses it for pane navigation.
    this.scope = new Scope(this.app.scope);
    this.scope.register([], 'Escape', (e: KeyboardEvent) => {
      if (e.isComposing || this.sessions.isComposing) return;
      const activeTab = this.tabManager?.getActiveTab();
      if (this.sessions.handleEscape()) return false;
      // Menus also consume Escape in the capture phase; this covers a keymap that sees it first.
      if (activeTab?.composer.closeOpenMenu()) return false;
      if (!e.defaultPrevented && activeTab) {
        cancelSelectedDestinationTurn(activeTab);
      }
      return false;
    });
    this.scope.register(['Mod'], 'Enter', (e: KeyboardEvent) => {
      if (e.isComposing || e.defaultPrevented) return;
      const activeTab = this.tabManager?.getActiveTab();
      if (!activeTab) return;
      if (sendTabInputMessageFromExplicitEnterShortcut(activeTab, e, { requireInputFocus: true })) {
        return false;
      }
    });

    // File open event
    this.registerEvent(
      this.plugin.app.workspace.on('file-open', (file) => {
        this.handleWorkspaceFileOpen(file);
      })
    );
    this.registerEvent(
      this.plugin.app.metadataCache.on('changed', (file) => {
        this.handleLinkedContentMetadataChanged(file);
      })
    );
    this.registerEvent(
      this.plugin.app.metadataCache.on('resolve', (file) => {
        this.handleLinkedContentMetadataChanged(file);
      })
    );
    this.registerEvent(
      this.plugin.app.metadataCache.on('resolved', () => {
        this.handleLinkedContentMetadataChanged(null);
      })
    );

    // Click outside to close the unified composer dropdown.
    this.registerDomEvent(activeDocument, 'click', (e) => {
      this.tabManager?.getActiveTab()?.composer.dismissDropdownFor(e.target);
    });
  }

  // ============================================
  // Public API
  // ============================================

  /** Gets the currently active tab. */
  getActiveTab(): ChatTab | null {
    return this.tabManager?.getActiveTab() ?? null;
  }

  /** Focuses the active tab's composer. */
  focusActiveInput(): void {
    this.tabManager?.getActiveTab()?.composer.focus();
  }

  /** Appends text to the active composer without sending it. */
  appendToActiveInput(text: string): boolean {
    const activeTab = this.tabManager?.getActiveTab();
    if (!activeTab || !text) return false;
    // Typing into a preview retains it, so appending does too.
    this.tabManager?.retainTabs([activeTab.id]);
    return activeTab.composer.appendText(text);
  }

  notifyConversationListChanged(): void {
    for (const tab of this.tabManager?.getAllTabs() ?? []) tab.composer.invalidateSessionMentions();
    this.sessions.invalidate();
  }

  private notifyConversationNavigationChanged(): void {
    this.sessions.invalidate();
    this.notifyOtherViews();
  }

  private notifyOtherViews(): void {
    for (const view of this.plugin.getAllViews()) {
      if (view !== this) {
        view.notifyConversationListChanged();
      }
    }
  }

  // ============================================
  // Zen mode source
  // ============================================

  getZenPresentation(): ZenPresentationPort | null {
    if (!this.tabWorkspace.isReady) return null;
    return this.tabManager?.getActiveTab()?.zenPresentation ?? null;
  }

  getZenProviderId(): ProviderId | null {
    return this.resolveBrandProviderId();
  }

  onZenPresentationChanged(listener: () => void): () => void {
    this.zenPresentationListeners.add(listener);
    return () => {
      this.zenPresentationListeners.delete(listener);
    };
  }

  attachZenPresentation(slots: ZenModeSlots): () => void {
    return this.presentation.attachZen(slots);
  }

  private notifyZenPresentationChanged(): void {
    for (const listener of [...this.zenPresentationListeners]) listener();
  }

  private startZenModeSource(): void {
    if (this.zenSourceRegistration) return;
    this.zenSourceRegistration = this.plugin.registerZenModeSource(this);
  }

  private stopZenModeSource(): void {
    const unregister = this.zenSourceRegistration;
    this.zenSourceRegistration = null;
    unregister?.();
  }

  /** Gets the tab manager. */
  getTabManager(): TabManager | null {
    return this.tabManager;
  }

  /** Gets shared view controls that should preserve active tab selection context. */
  getSharedSelectionFocusScopeEls(): HTMLElement[] {
    return this.presentation.getSharedFocusScopeEls();
  }
}
