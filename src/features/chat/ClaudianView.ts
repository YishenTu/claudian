import type { EventRef, WorkspaceLeaf } from 'obsidian';
import { ItemView, Menu, Notice, Scope, setIcon } from 'obsidian';

import { StartupProfiler } from '../../core/performance/StartupProfiler';
import { getHiddenProviderCommandSet } from '../../core/providers/commands/hiddenCommands';
import {
  getProviderSettingsSnapshotWithModel,
  resolveConversationModel,
} from '../../core/providers/conversationModel';
import { ProviderRegistry } from '../../core/providers/ProviderRegistry';
import { ProviderSettingsCoordinator } from '../../core/providers/ProviderSettingsCoordinator';
import { type AppTabManagerState, DEFAULT_CHAT_PROVIDER_ID, type ProviderId } from '../../core/providers/types';
import { VIEW_TYPE_CLAUDIAN } from '../../core/types';
import {
  cancelScheduledAnimationFrame,
  scheduleAnimationFrame,
  type ScheduledAnimationFrame,
} from '../../utils/animationFrame';
import type { FeatureHost, FeatureTabManagerHost } from '../FeatureHost';
import type { HistoryConversationStatus } from './controllers/ConversationController';
import { MentionCacheCoordinator } from './services/MentionCacheCoordinator';
import { TabStatePersistenceCoordinator } from './services/TabStatePersistenceCoordinator';
import { getObsidianLanguage } from './session-manager/ProvisionalNoteNames';
import { renderSessionGroupToggleIcon } from './session-manager/SessionManagerIcons';
import {
  commitProvisionalTab,
  getTabProviderId,
  sendTabInputMessageFromExplicitEnterShortcut,
  updatePlanModeUI,
} from './tabs/Tab';
import { TabBar } from './tabs/TabBar';
import { TabManager } from './tabs/TabManager';
import type { TabData, TabId } from './tabs/types';
import { recalculateUsageForModel } from './utils/usageInfo';

type LoadableView = {
  containerEl?: HTMLElement;
  load: () => Promise<void> | void;
};

const WIDE_SESSION_LAYOUT_MIN_WIDTH = 600;
const MIN_CHAT_PANEL_WIDTH = 320;
const MIN_SESSION_SIDEBAR_WIDTH = 180;
const SESSION_RESIZER_WIDTH = 5;
const SESSION_RESIZE_KEYBOARD_STEP = 16;

export class ClaudianView extends ItemView {
  private plugin: FeatureHost;

  // Tab management
  private tabManager: TabManager | null = null;
  private mentionCacheCoordinator: MentionCacheCoordinator | null = null;
  private tabBar: TabBar | null = null;
  private tabBarContainerEl: HTMLElement | null = null;
  private chatPanelEl: HTMLElement | null = null;
  private tabContentEl: HTMLElement | null = null;
  private navRowContent: HTMLElement | null = null;
  private inputFooterEl: HTMLElement | null = null;
  private inputNavRowHostEl: HTMLElement | null = null;
  private activeInputSlotEl: HTMLElement | null = null;
  private activeInputTabId: TabId | null = null;

  // DOM Elements
  private viewContainerEl: HTMLElement | null = null;
  private newTabButtonEl: HTMLElement | null = null;
  private sessionNewButtonEl: HTMLElement | null = null;
  private sessionGroupToggleButtonEl: HTMLElement | null = null;

  // History elements
  private historyDropdown: HTMLElement | null = null;
  private historyRenderAbortController: AbortController | null = null;
  private sessionSidebarEl: HTMLElement | null = null;
  private sessionSidebarResizerEl: HTMLElement | null = null;
  private sessionSidebarRenderAbortController: AbortController | null = null;
  private sessionSidebarResizeObserver: ResizeObserver | null = null;
  private sessionSidebarResizeCleanup: (() => void) | null = null;
  private sessionSidebarWidth: number | null = null;
  private isWideSessionLayout = false;
  private isArchiveSessionView = false;
  private collapsedSessionGroupKeys?: Set<string> = new Set<string>();
  private sessionGroupKeys?: Set<string> = new Set<string>();

  // Event refs for cleanup
  private eventRefs: EventRef[] = [];

  // Debouncing for tab bar updates
  private pendingTabBarUpdate: ScheduledAnimationFrame | null = null;
  private tabStatePersistence: TabStatePersistenceCoordinator;

  constructor(leaf: WorkspaceLeaf, plugin: FeatureHost) {
    super(leaf);
    this.plugin = plugin;
    this.tabStatePersistence = new TabStatePersistenceCoordinator(
      state => this.plugin.storage.setTabManagerState(state),
    );

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
      const conversation = tab.conversationId
        ? this.plugin.getConversationSync(tab.conversationId)
        : null;
      const modelOverride = conversation
        ? resolveConversationModel(this.plugin.settings, providerId, conversation).model
        : tab.conversationId === null
        ? tab.draftModel
        : null;
      const providerSettings = getProviderSettingsSnapshotWithModel(
        this.plugin.settings,
        providerId,
        modelOverride,
      );
      const model = providerSettings.model;
      const uiConfig = ProviderRegistry.getChatUIConfig(providerId);
      const capabilities = ProviderRegistry.getCapabilities(providerId);
      const contextWindow = uiConfig.getContextWindowSize(
        model,
        providerSettings.customContextLimits,
        providerSettings,
      );

      if (tab.state.usage) {
        tab.state.usage = recalculateUsageForModel(tab.state.usage, model, contextWindow);
      }

      tab.ui.modelSelector?.updateDisplay();
      tab.ui.modelSelector?.renderOptions();
      tab.ui.modeSelector?.updateDisplay();
      tab.ui.modeSelector?.renderOptions();
      tab.ui.thinkingBudgetSelector?.updateDisplay();
      tab.ui.permissionToggle?.updateDisplay();
      tab.ui.serviceTierToggle?.updateDisplay();
      tab.dom.inputWrapper.toggleClass(
        'claudian-input-plan-mode',
        providerSettings.permissionMode === 'plan' && capabilities.supportsPlanMode,
      );
    }

    if (!changedProviderId) {
      this.tabManager?.primeProviderExecution();
    }
  }

  invalidateProviderCommandCaches(providerIds?: ProviderId[]): void {
    this.tabManager?.invalidateProviderCommandCaches(providerIds);
  }

  invalidateProviderResources(providerIds: ProviderId[], generation: number): void {
    this.tabManager?.invalidateProviderResources(providerIds, generation);
  }

  /** Updates provider-scoped hidden commands on all tabs after settings changes. */
  updateHiddenProviderCommands(): void {
    for (const tab of this.tabManager?.getAllTabs() ?? []) {
      tab.ui.slashCommandDropdown?.setHiddenCommands(
        getHiddenProviderCommandSet(this.plugin.settings, getTabProviderId(tab, this.plugin)),
      );
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

    this.navRowContent = this.buildNavRowContent();
    this.buildViewLayout();
    if (!this.tabContentEl) return;

    this.tabManager = new TabManager(
      this.plugin,
      this.tabContentEl,
      this,
      {
        onTabCreated: () => {
          this.updateTabBar();
          this.notifyConversationNavigationChanged();
          this.updateInputLocation();
          this.syncProviderBrandColor();
        },
        onActiveTabChanged: () => {
          this.updateTabBar();
          this.notifyConversationNavigationChanged();
          this.updateInputLocation();
          this.syncProviderBrandColor();
          this.persistCurrentTabState();
        },
        onTabSwitched: () => {
          this.updateTabBar();
          this.notifyConversationNavigationChanged();
          this.updateInputLocation();
          this.syncProviderBrandColor();
        },
        onTabClosed: () => {
          this.updateTabBar();
          this.notifyConversationNavigationChanged();
          this.updateInputLocation();
          this.persistCurrentTabState();
        },
        onTabStreamingChanged: () => {
          this.updateTabBar();
          this.notifyConversationNavigationChanged();
        },
        onTabRewindingChanged: () => this.updateTabBar(),
        onTabTitleChanged: () => this.updateTabBar(),
        onTabAttentionChanged: () => this.updateTabBar(),
        onTabConversationChanged: () => {
          this.updateTabBar();
          this.notifyConversationNavigationChanged();
          this.syncProviderBrandColor();
          this.persistCurrentTabState();
        },
        onTabProviderChanged: () => {
          this.updateTabBar();
          this.syncProviderBrandColor();
        },
      }
    );
    this.mentionCacheCoordinator = new MentionCacheCoordinator(
      () => (this.tabManager?.getAllTabs() ?? []).map(tab => ({
        fileContextManager: tab.ui.fileContextManager,
      })),
    );

    this.wireEventHandlers();
    await this.restoreCurrentTab();
    this.syncProviderBrandColor();
    this.attachNavRowContentToInputFooter();
    this.updateInputLocation();
    this.updateTabBarVisibility();
    this.startSessionSidebarLayoutObserver();
  }

  async onClose() {
    this.cancelHistoryRendering();
    this.cancelSessionSidebarRendering();
    this.disconnectSessionSidebarLayoutObserver();
    this.stopSessionSidebarResize();
    if (this.pendingTabBarUpdate !== null) {
      cancelScheduledAnimationFrame(this.pendingTabBarUpdate);
      this.pendingTabBarUpdate = null;
    }

    for (const ref of this.eventRefs) {
      this.plugin.app.vault.offref(ref);
    }
    this.eventRefs = [];

    try {
      await this.flushCurrentTabState();
    } catch {
      // The storage boundary reports persistence failures. Teardown must still complete.
    } finally {
      this.tabStatePersistence?.dispose();
      try {
        this.restoreActiveInputToTabContent();
        await this.tabManager?.destroy();
      } finally {
        this.tabManager = null;
        this.mentionCacheCoordinator = null;

        this.tabBar?.destroy();
        this.tabBar = null;
        this.scope = null;
      }
    }
  }

  // ============================================
  // UI Building
  // ============================================

  private buildViewLayout(): void {
    if (!this.viewContainerEl) return;

    this.chatPanelEl = this.viewContainerEl.createDiv({ cls: 'claudian-chat-panel' });
    this.tabContentEl = this.chatPanelEl.createDiv({ cls: 'claudian-tab-content-container' });
    this.buildInputFooter();

    this.sessionSidebarResizerEl = this.viewContainerEl.createDiv({
      cls: 'claudian-session-resizer',
    });
    this.sessionSidebarResizerEl.setAttribute('role', 'separator');
    this.sessionSidebarResizerEl.setAttribute('aria-label', 'Resize conversation sessions');
    this.sessionSidebarResizerEl.setAttribute('aria-orientation', 'vertical');
    this.sessionSidebarResizerEl.setAttribute('tabindex', '0');
    this.sessionSidebarResizerEl.addEventListener('pointerdown', (event) => {
      this.startSessionSidebarResize(event);
    });
    this.sessionSidebarResizerEl.addEventListener('keydown', (event) => {
      this.handleSessionSidebarResizeKeydown(event);
    });

    this.sessionSidebarEl = this.viewContainerEl.createDiv({ cls: 'claudian-session-sidebar' });
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
      onNewTab: () => this.requestNewTab(),
    });

    const navActionsEl = wrapper.createDiv({ cls: 'claudian-input-nav-actions' });

    this.newTabButtonEl = navActionsEl.createDiv({ cls: 'claudian-input-nav-btn claudian-new-tab-btn' });
    setIcon(this.newTabButtonEl, 'square-plus');
    this.newTabButtonEl.setAttribute('aria-label', 'New tab');
    this.newTabButtonEl.addEventListener('click', () => this.requestNewTab());

    const newBtn = navActionsEl.createDiv({
      cls: 'claudian-input-nav-btn claudian-new-conversation-btn',
    });
    setIcon(newBtn, 'square-pen');
    newBtn.setAttribute('aria-label', 'New conversation');
    newBtn.addEventListener('click', () => this.requestNewConversation());

    // History dropdown
    const historyContainer = navActionsEl.createDiv({ cls: 'claudian-history-container' });
    const historyBtn = historyContainer.createDiv({ cls: 'claudian-input-nav-btn' });
    setIcon(historyBtn, 'history');
    historyBtn.setAttribute('aria-label', 'Chat history');

    this.historyDropdown = historyContainer.createDiv({ cls: 'claudian-history-menu' });

    historyBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.toggleHistoryDropdown();
    });

    return wrapper;
  }

  private requestNewTab(): void {
    void this.createNewTab().catch(() => new Notice('Failed to create tab'));
  }

  private requestNewConversation(): void {
    void (async () => {
      await this.tabManager?.createNewConversation();
      this.updateHistoryDropdown();
    })().catch(() => new Notice('Failed to create conversation'));
  }

  private requestDualNew(): void {
    void this.activateOrCreateDraftTab()
      .catch(() => new Notice('Failed to open a new tab'));
  }

  private async activateOrCreateDraftTab(): Promise<void> {
    const activeTab = this.tabManager?.getActiveTab();
    if (activeTab?.conversationId === null) {
      activeTab.dom.inputEl.focus();
      return;
    }

    const draftTab = this.findMostRecentUnboundTab();
    if (draftTab) {
      await this.tabManager?.switchToTab(draftTab.id);
      draftTab.dom.inputEl.focus();
      return;
    }

    await this.createNewTab();
  }

  async handleNewConversationCommand(): Promise<boolean> {
    if (!this.isWideSessionLayout) return false;
    await this.activateOrCreateDraftTab();
    return true;
  }

  private findMostRecentUnboundTab(): TabData | null {
    const tabs = this.tabManager?.getAllTabs() ?? [];
    for (let index = tabs.length - 1; index >= 0; index -= 1) {
      if (tabs[index].conversationId === null) {
        return tabs[index];
      }
    }
    return null;
  }

  private buildInputFooter(): void {
    if (!this.chatPanelEl) return;

    this.inputFooterEl = this.chatPanelEl.createDiv({ cls: 'claudian-input-footer' });
    this.inputNavRowHostEl = this.inputFooterEl.createDiv({
      cls: 'claudian-input-nav-row claudian-view-input-nav-row',
    });
    this.activeInputSlotEl = this.inputFooterEl.createDiv({ cls: 'claudian-active-input-slot' });
  }

  private attachNavRowContentToInputFooter(): void {
    if (!this.inputNavRowHostEl || !this.navRowContent) return;

    this.tabBar?.captureScrollPosition();
    this.inputNavRowHostEl.appendChild(this.navRowContent);
    this.tabBar?.restoreScrollPosition();
  }

  private updateInputLocation(): void {
    const activeTab = this.tabManager?.getActiveTab();
    if (!this.activeInputSlotEl) return;

    if (!activeTab) {
      this.activeInputSlotEl.empty();
      this.activeInputTabId = null;
      return;
    }

    if (this.activeInputTabId && this.activeInputTabId !== activeTab.id) {
      const previousTab = this.tabManager?.getTab(this.activeInputTabId);
      if (previousTab) {
        previousTab.dom.contentEl.appendChild(previousTab.dom.inputComposerEl);
      }
    }

    if (this.activeInputTabId === activeTab.id) {
      if (activeTab.dom.inputComposerEl.parentElement !== this.activeInputSlotEl) {
        this.activeInputSlotEl.appendChild(activeTab.dom.inputComposerEl);
      }
      return;
    }

    this.activeInputSlotEl.empty();
    this.activeInputSlotEl.appendChild(activeTab.dom.inputComposerEl);
    this.activeInputTabId = activeTab.id;
  }

  private restoreActiveInputToTabContent(): void {
    if (!this.activeInputTabId) return;

    const activeInputTab = this.tabManager?.getTab(this.activeInputTabId);
    if (activeInputTab) {
      activeInputTab.dom.contentEl.appendChild(activeInputTab.dom.inputComposerEl);
    }
    this.activeInputSlotEl?.empty();
    this.activeInputTabId = null;
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
      // If streaming, treat close like user interrupt (force close cancels the stream)
      const force = tab?.state.isStreaming ?? false;
      await this.tabManager?.closeTab(tabId, force);
      this.updateTabBarVisibility();
    } catch {
      new Notice('Failed to close tab');
    }
  }

  async createNewTab(): Promise<void> {
    const tab = await this.tabManager?.createTab();
    if (!tab) return;
    this.updateTabBarVisibility();
    tab.dom.inputEl.focus();
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

    const tabCount = this.tabManager.getTabCount();
    const showTabBar = tabCount >= 2;

    this.tabBarContainerEl.toggleClass('claudian-hidden', !showTabBar);

    this.updateNewTabButtonVisibility();
  }

  private updateNewTabButtonVisibility(): void {
    if (!this.tabManager) return;

    const canCreateTab = this.tabManager.canCreateTab();
    this.setNewButtonAvailability(this.newTabButtonEl, canCreateTab);
    this.setNewButtonAvailability(
      this.sessionNewButtonEl,
      canCreateTab || this.findMostRecentUnboundTab() !== null,
    );
  }

  private setNewButtonAvailability(button: HTMLElement | null, isAvailable: boolean): void {
    if (!button) return;

    button.toggleClass('claudian-hidden', !isAvailable);
    if (isAvailable) {
      button.removeAttribute('aria-disabled');
      button.removeAttribute('aria-hidden');
      return;
    }

    button.setAttribute('aria-disabled', 'true');
    button.setAttribute('aria-hidden', 'true');
  }

  /** Sets `data-provider` on the root container so CSS brand color follows the active provider. */
  private syncProviderBrandColor(): void {
    if (!this.viewContainerEl) return;
    const activeTab = this.tabManager?.getActiveTab();
    const providerId = activeTab ? getTabProviderId(activeTab, this.plugin) : DEFAULT_CHAT_PROVIDER_ID;
    this.viewContainerEl.dataset.provider = providerId;
  }

  // ============================================
  // History Dropdown
  // ============================================

  private toggleHistoryDropdown(): void {
    if (!this.historyDropdown) return;

    const isVisible = this.historyDropdown.hasClass('visible');
    if (isVisible) {
      this.historyDropdown.removeClass('visible');
      this.cancelHistoryRendering();
    } else {
      this.historyDropdown.addClass('visible');
      this.renderHistoryDropdown();
    }
  }

  private historyDropdownDirty = true;
  private sessionSidebarDirty = true;
  private historySurfaceRendered = false;

  private updateHistoryDropdown(): void {
    this.historyDropdownDirty = true;
    this.sessionSidebarDirty = true;
    if (this.historyDropdown?.hasClass('visible')) {
      this.renderHistoryDropdown();
    }
    if (this.isWideSessionLayout) {
      this.renderSessionSidebar();
    }
  }

  private renderHistoryDropdown(): void {
    if (!this.historyDropdown || !this.historyDropdownDirty) return;

    this.cancelHistoryRendering();
    const abortController = new AbortController();
    this.historyRenderAbortController = abortController;

    const span = this.historySurfaceRendered ? null : StartupProfiler.start('history-list-render');
    this.historySurfaceRendered = true;

    try {
      this.renderHistorySurface(this.historyDropdown, abortController.signal);
      this.historyDropdownDirty = false;
    } finally {
      if (span) {
        StartupProfiler.finish(span);
      }
    }
  }

  private renderSessionSidebar(): void {
    if (!this.sessionSidebarEl || !this.sessionSidebarDirty || !this.isWideSessionLayout) return;

    this.cancelSessionSidebarRendering();
    const abortController = new AbortController();
    this.sessionSidebarRenderAbortController = abortController;

    const span = this.historySurfaceRendered ? null : StartupProfiler.start('history-list-render');
    this.historySurfaceRendered = true;

    try {
      this.sessionNewButtonEl = null;
      this.sessionGroupToggleButtonEl = null;
      this.renderHistorySurface(this.sessionSidebarEl, abortController.signal, 'sessions');
      this.buildSessionHeaderActions(this.sessionSidebarEl);
      this.sessionSidebarDirty = false;
    } finally {
      if (span) {
        StartupProfiler.finish(span);
      }
    }
  }

  private renderHistorySurface(
    container: HTMLElement,
    signal: AbortSignal,
    navigationMode: 'history' | 'sessions' = 'history',
  ): void {
    const activeTab = this.tabManager?.getActiveTab();
    const conversationController = activeTab?.controllers.conversationController;
    if (!conversationController) {
      container.empty();
      return;
    }

    const isArchiveView = this.isArchiveSessionView;
    conversationController.renderHistoryDropdown(container, {
      onSelectConversation: (id) => navigationMode === 'sessions'
        ? this.openSessionConversation(id)
        : this.openHistoryConversation(id),
      ...(navigationMode === 'history' && !isArchiveView
        ? {
            onOpenConversationInNewTab: (id: string, activate?: boolean) =>
              this.openHistoryConversationInNewTab(id, activate),
          }
        : {}),
      getConversationStatus: (id) => this.getHistoryConversationStatus(id),
      onRerender: () => this.updateHistoryDropdown(),
      showOpenStateLabels: navigationMode === 'history',
      showOpenStateActions: navigationMode === 'history' && !isArchiveView,
      preserveListState: true,
      sessionScope: isArchiveView ? 'archived' : 'active',
      sessionActionMode: isArchiveView ? 'archived' : 'active',
      historyHeaderLabel: isArchiveView ? 'Archived' : 'Sessions',
      allowConversationSelection: !isArchiveView,
      onSetConversationPinned: (id: string, isPinned: boolean) => (
        this.setConversationPinned(id, isPinned)
      ),
      onSetConversationArchived: (id: string, isArchived: boolean) => (
        this.setConversationArchived(id, isArchived)
      ),
      ...(navigationMode === 'sessions'
        ? {
            organization: this.getSessionManagerOrganization(),
            sort: this.getSessionManagerSort(),
            language: getObsidianLanguage(this.plugin.settings.locale),
            noteExists: (notePath: string) => this.noteExists(notePath),
            showOpenStateActions: false,
            showPinnedSection: !isArchiveView,
            showArchivedSection: isArchiveView,
            collapsedGroupKeys: this.getCollapsedSessionGroupKeys(),
            onGroupCollapseChange: (groupKey: string, collapsed: boolean) => {
              const collapsedGroupKeys = this.getCollapsedSessionGroupKeys();
              if (collapsed) {
                collapsedGroupKeys.add(groupKey);
              } else {
                collapsedGroupKeys.delete(groupKey);
              }
              this.updateSessionGroupToggleButton();
            },
            onGroupKeysChange: (groupKeys: readonly string[]) => {
              this.sessionGroupKeys = new Set(groupKeys);
            },
          }
        : {}),
      signal,
    });
    if (navigationMode === 'history') {
      this.buildHistoryArchiveNavigation(container);
    }
  }

  private buildSessionHeaderActions(container: HTMLElement): void {
    const header = container.querySelector<HTMLElement>('.claudian-session-list-header');
    const list = container.querySelector<HTMLElement>('.claudian-history-list');
    if (!header || !list) return;

    const newControl = container.createDiv({ cls: 'claudian-session-new-control' });
    newControl.setAttribute('role', 'button');
    newControl.setAttribute('tabindex', '0');
    newControl.setAttribute('aria-label', 'New');
    const newIcon = newControl.createSpan({ cls: 'claudian-session-new-icon' });
    setIcon(newIcon, 'plus');
    newControl.createSpan({ cls: 'claudian-session-new-label', text: 'New' });
    newControl.addEventListener('click', () => this.requestSessionNew());
    newControl.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      this.requestSessionNew();
    });
    container.insertBefore(newControl, list);
    this.sessionNewButtonEl = newControl;

    const archiveControl = container.createDiv({ cls: 'claudian-session-archive-control' });
    archiveControl.setAttribute('role', 'button');
    archiveControl.setAttribute('tabindex', '0');
    const archiveLabel = this.isArchiveSessionView ? 'Sessions' : 'Archive';
    archiveControl.setAttribute('aria-label', archiveLabel);
    const archiveIcon = archiveControl.createSpan({ cls: 'claudian-session-nav-icon' });
    setIcon(archiveIcon, this.isArchiveSessionView ? 'arrow-left' : 'archive');
    archiveControl.createSpan({
      cls: 'claudian-session-nav-label',
      text: archiveLabel,
    });
    const toggleArchiveView = (): void => {
      this.setArchiveSessionView(!this.isArchiveSessionView);
    };
    archiveControl.addEventListener('click', toggleArchiveView);
    archiveControl.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      toggleArchiveView();
    });
    container.insertBefore(archiveControl, list);

    this.sessionGroupToggleButtonEl = null;
    const actions = header.createDiv({ cls: 'claudian-session-header-actions' });
    const sessionGroupKeys = this.getSessionGroupKeys();
    if (
      this.getSessionManagerOrganization() === 'linked-note'
      && sessionGroupKeys.size > 0
    ) {
      const collapsedGroupKeys = this.getCollapsedSessionGroupKeys();
      const allCollapsed = [...sessionGroupKeys].every(groupKey => (
        collapsedGroupKeys.has(groupKey)
      ));
      this.sessionGroupToggleButtonEl = this.createSessionHeaderAction(
        actions,
        icon => renderSessionGroupToggleIcon(
          icon,
          allCollapsed ? 'expand' : 'collapse',
        ),
        allCollapsed ? 'Expand all groups' : 'Collapse all groups',
        () => this.toggleAllSessionGroups(),
      );
    }
    const optionsButton = this.createSessionHeaderAction(
      actions,
      'ellipsis',
      'Session options',
      (event) => this.showSessionOptionsMenu(optionsButton, event),
    );

    this.updateNewTabButtonVisibility();
  }

  private requestSessionNew(): void {
    if (this.isArchiveSessionView) {
      this.setArchiveSessionView(false);
    }
    this.requestDualNew();
  }

  private setArchiveSessionView(isArchiveSessionView: boolean): void {
    if (this.isArchiveSessionView === isArchiveSessionView) return;
    this.isArchiveSessionView = isArchiveSessionView;
    this.historyDropdownDirty = true;
    this.sessionSidebarDirty = true;
    if (this.isWideSessionLayout) {
      this.renderSessionSidebar();
    } else if (this.historyDropdown?.hasClass('visible')) {
      this.renderHistoryDropdown();
    }
  }

  private buildHistoryArchiveNavigation(container: HTMLElement): void {
    const list = container.querySelector<HTMLElement>('.claudian-history-list');
    if (!list) return;

    const label = this.isArchiveSessionView ? 'Sessions' : 'Archive';
    const control = list.createDiv({ cls: 'claudian-history-archive-control' });
    control.setAttribute('role', 'button');
    control.setAttribute('tabindex', '0');
    control.setAttribute('aria-label', label);
    const icon = control.createSpan({ cls: 'claudian-session-nav-icon' });
    setIcon(icon, this.isArchiveSessionView ? 'arrow-left' : 'archive');
    control.createSpan({ cls: 'claudian-session-nav-label', text: label });
    const toggleArchiveView = (): void => {
      this.setArchiveSessionView(!this.isArchiveSessionView);
    };
    control.addEventListener('click', toggleArchiveView);
    control.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      toggleArchiveView();
    });
    list.insertBefore(control, list.firstChild);
  }

  private async setConversationPinned(
    conversationId: string,
    isPinned: boolean,
  ): Promise<void> {
    await this.plugin.setConversationPinned(conversationId, isPinned);
    if (!isPinned) return;

    for (const tab of this.tabManager?.getAllTabs() ?? []) {
      if (tab.conversationId === conversationId) {
        commitProvisionalTab(tab);
      }
    }
  }

  private async setConversationArchived(
    conversationId: string,
    isArchived: boolean,
  ): Promise<void> {
    if (!isArchived) {
      await this.plugin.setConversationArchived(conversationId, false);
      return;
    }

    const openTabs = this.getOpenConversationTabs(conversationId);
    if (openTabs.some(({ tab }) => tab.state.isStreaming)) {
      new Notice('Running sessions cannot be archived');
      return;
    }

    for (const { manager, tab } of openTabs) {
      const didClose = await manager.closeTab(tab.id);
      if (!didClose) {
        throw new Error('Failed to close the session before archiving');
      }
    }
    await this.plugin.setConversationArchived(conversationId, true);
  }

  private getOpenConversationTabs(conversationId: string): Array<{
    manager: FeatureTabManagerHost;
    tab: TabData;
  }> {
    const managers = new Set(
      this.plugin.getAllViews()
        .map(view => view.getTabManager())
        .filter((manager): manager is NonNullable<typeof manager> => manager !== null),
    );
    if (this.tabManager) {
      managers.add(this.tabManager);
    }

    const openTabs: Array<{ manager: FeatureTabManagerHost; tab: TabData }> = [];
    for (const manager of managers) {
      for (const tab of manager.getAllTabs()) {
        if (tab.conversationId === conversationId) {
          openTabs.push({ manager, tab });
        }
      }
    }
    return openTabs;
  }

  private retainPinnedProvisionalTabs(): void {
    for (const tab of this.tabManager?.getAllTabs() ?? []) {
      if (
        tab.conversationId
        && this.plugin.getConversationSync(tab.conversationId)?.isPinned
      ) {
        commitProvisionalTab(tab);
      }
    }
  }

  private createSessionHeaderAction(
    parent: HTMLElement,
    icon: string | ((container: HTMLElement) => void),
    label: string,
    action: (event?: MouseEvent) => void,
  ): HTMLElement {
    const control = parent.createDiv({ cls: 'claudian-session-header-btn' });
    control.setAttribute('role', 'button');
    control.setAttribute('tabindex', '0');
    control.setAttribute('aria-label', label);

    const iconEl = control.createDiv({ cls: 'claudian-session-header-icon' });
    if (typeof icon === 'string') {
      setIcon(iconEl, icon);
    } else {
      icon(iconEl);
    }

    control.addEventListener('click', (event) => action(event));
    control.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      action();
    });
    return control;
  }

  private getSessionManagerOrganization(): 'list' | 'linked-note' {
    return this.plugin.settings.sessionManagerOrganization === 'linked-note'
      ? 'linked-note'
      : 'list';
  }

  private getSessionManagerSort(): 'last-updated' | 'created' | 'title' {
    const sort = this.plugin.settings.sessionManagerSort;
    return sort === 'created' || sort === 'title' ? sort : 'last-updated';
  }

  private getCollapsedSessionGroupKeys(): Set<string> {
    return this.collapsedSessionGroupKeys ??= new Set<string>();
  }

  private getSessionGroupKeys(): Set<string> {
    return this.sessionGroupKeys ??= new Set<string>();
  }

  private updateSessionGroupToggleButton(): void {
    const button = this.sessionGroupToggleButtonEl;
    if (!button) return;

    const sessionGroupKeys = this.getSessionGroupKeys();
    const collapsedGroupKeys = this.getCollapsedSessionGroupKeys();
    const allCollapsed = sessionGroupKeys.size > 0
      && [...sessionGroupKeys].every(groupKey => collapsedGroupKeys.has(groupKey));
    button.setAttribute(
      'aria-label',
      allCollapsed ? 'Expand all groups' : 'Collapse all groups',
    );
    const icon = button.querySelector<HTMLElement>('.claudian-session-header-icon');
    if (icon) {
      renderSessionGroupToggleIcon(
        icon,
        allCollapsed ? 'expand' : 'collapse',
      );
    }
  }

  private toggleAllSessionGroups(): void {
    const sessionGroupKeys = this.getSessionGroupKeys();
    if (sessionGroupKeys.size === 0) return;

    const collapsedGroupKeys = this.getCollapsedSessionGroupKeys();
    const shouldExpand = [...sessionGroupKeys].every(groupKey => (
      collapsedGroupKeys.has(groupKey)
    ));
    for (const groupKey of sessionGroupKeys) {
      if (shouldExpand) {
        collapsedGroupKeys.delete(groupKey);
      } else {
        collapsedGroupKeys.add(groupKey);
      }
    }
    this.refreshSessionManagerPresentation();
  }

  private noteExists(notePath: string): boolean {
    const { vault } = this.plugin.app;
    return typeof vault.getAbstractFileByPath !== 'function'
      || vault.getAbstractFileByPath(notePath) !== null;
  }

  private showSessionOptionsMenu(anchor: HTMLElement, event?: MouseEvent): void {
    const menu = new Menu();
    const organization = this.getSessionManagerOrganization();
    const sort = this.getSessionManagerSort();

    menu.addItem(item => item
      .setTitle('Organize sessions')
      .setIsLabel(true));
    menu.addItem(item => item
      .setTitle('In one list')
      .setChecked(organization === 'list')
      .onClick(() => this.setSessionManagerOrganization('list')));
    menu.addItem(item => item
      .setTitle('By linked note')
      .setChecked(organization === 'linked-note')
      .onClick(() => this.setSessionManagerOrganization('linked-note')));
    menu.addSeparator();
    menu.addItem(item => item
      .setTitle('Sort sessions by')
      .setIsLabel(true));
    menu.addItem(item => item
      .setTitle('Last activity')
      .setChecked(sort === 'last-updated')
      .onClick(() => this.setSessionManagerSort('last-updated')));
    menu.addItem(item => item
      .setTitle('Created')
      .setChecked(sort === 'created')
      .onClick(() => this.setSessionManagerSort('created')));
    menu.addItem(item => item
      .setTitle('Title')
      .setChecked(sort === 'title')
      .onClick(() => this.setSessionManagerSort('title')));

    if (event) {
      menu.showAtMouseEvent(event);
      return;
    }
    const rect = anchor.getBoundingClientRect();
    menu.showAtPosition({ x: rect.left, y: rect.bottom }, anchor.ownerDocument);
  }

  private setSessionManagerOrganization(
    organization: 'list' | 'linked-note',
  ): void {
    void this.plugin.mutateSettings((settings) => {
      settings.sessionManagerOrganization = organization;
    }).then(() => this.refreshSessionManagerPresentation())
      .catch(() => new Notice('Failed to update session organization'));
  }

  private setSessionManagerSort(sort: 'last-updated' | 'created' | 'title'): void {
    void this.plugin.mutateSettings((settings) => {
      settings.sessionManagerSort = sort;
    }).then(() => this.refreshSessionManagerPresentation())
      .catch(() => new Notice('Failed to update session sorting'));
  }

  private refreshSessionManagerPresentation(): void {
    this.sessionSidebarDirty = true;
    this.renderSessionSidebar();
    for (const view of this.plugin.getAllViews()) {
      if (view !== this) {
        view.notifyConversationListChanged();
      }
    }
  }

  private startSessionSidebarLayoutObserver(): void {
    if (!this.viewContainerEl) return;

    const viewContainerEl = this.viewContainerEl;
    const ResizeObserverConstructor = viewContainerEl.ownerDocument.defaultView?.ResizeObserver;
    if (typeof ResizeObserverConstructor === 'function') {
      this.sessionSidebarResizeObserver = new ResizeObserverConstructor((entries) => {
        const entry = entries.at(-1);
        const width = entry?.contentRect.width ?? viewContainerEl.getBoundingClientRect().width;
        this.updateSessionSidebarLayout(width);
      });
      this.sessionSidebarResizeObserver.observe(viewContainerEl);
    }

    this.updateSessionSidebarLayout(viewContainerEl.getBoundingClientRect().width);
  }

  private disconnectSessionSidebarLayoutObserver(): void {
    this.sessionSidebarResizeObserver?.disconnect();
    this.sessionSidebarResizeObserver = null;
  }

  private startSessionSidebarResize(event: PointerEvent): void {
    if (!this.isWideSessionLayout || event.button !== 0 || !this.sessionSidebarEl) return;

    event.preventDefault();
    this.stopSessionSidebarResize();

    const ownerDocument = (event.currentTarget as HTMLElement).ownerDocument;
    const startX = event.clientX;
    const startWidth = this.sessionSidebarWidth
      ?? this.sessionSidebarEl.getBoundingClientRect().width;

    const handlePointerMove = (moveEvent: PointerEvent): void => {
      this.setSessionSidebarWidth(startWidth - (moveEvent.clientX - startX));
    };
    const handlePointerEnd = (): void => {
      this.stopSessionSidebarResize();
    };

    ownerDocument.addEventListener('pointermove', handlePointerMove);
    ownerDocument.addEventListener('pointerup', handlePointerEnd);
    ownerDocument.addEventListener('pointercancel', handlePointerEnd);
    this.viewContainerEl?.addClass('claudian-resizing-session-sidebar');
    this.sessionSidebarResizeCleanup = () => {
      ownerDocument.removeEventListener('pointermove', handlePointerMove);
      ownerDocument.removeEventListener('pointerup', handlePointerEnd);
      ownerDocument.removeEventListener('pointercancel', handlePointerEnd);
      this.viewContainerEl?.removeClass('claudian-resizing-session-sidebar');
    };
  }

  private stopSessionSidebarResize(): void {
    const cleanup = this.sessionSidebarResizeCleanup;
    this.sessionSidebarResizeCleanup = null;
    cleanup?.();
  }

  private handleSessionSidebarResizeKeydown(event: KeyboardEvent): void {
    if (!this.isWideSessionLayout || !this.sessionSidebarEl) return;
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;

    event.preventDefault();
    const currentWidth = this.sessionSidebarWidth
      ?? this.sessionSidebarEl.getBoundingClientRect().width;
    const delta = event.key === 'ArrowLeft'
      ? SESSION_RESIZE_KEYBOARD_STEP
      : -SESSION_RESIZE_KEYBOARD_STEP;
    this.setSessionSidebarWidth(currentWidth + delta);
  }

  private setSessionSidebarWidth(requestedWidth: number): void {
    if (!this.viewContainerEl) return;

    const totalWidth = this.viewContainerEl.getBoundingClientRect().width;
    const maxWidth = Math.max(
      MIN_SESSION_SIDEBAR_WIDTH,
      totalWidth - MIN_CHAT_PANEL_WIDTH - SESSION_RESIZER_WIDTH,
    );
    const width = Math.round(Math.min(
      Math.max(requestedWidth, MIN_SESSION_SIDEBAR_WIDTH),
      maxWidth,
    ));

    this.sessionSidebarWidth = width;
    this.viewContainerEl.style.setProperty('--claudian-session-sidebar-width', `${width}px`);
    this.sessionSidebarResizerEl?.setAttribute('aria-valuenow', String(width));
    this.sessionSidebarResizerEl?.setAttribute('aria-valuemin', String(MIN_SESSION_SIDEBAR_WIDTH));
    this.sessionSidebarResizerEl?.setAttribute('aria-valuemax', String(Math.round(maxWidth)));
  }

  private updateSessionSidebarLayout(width: number): void {
    if (!this.viewContainerEl) return;

    const isWide = width >= WIDE_SESSION_LAYOUT_MIN_WIDTH;
    if (isWide === this.isWideSessionLayout) {
      if (isWide) {
        if (this.sessionSidebarWidth !== null) {
          this.setSessionSidebarWidth(this.sessionSidebarWidth);
        }
        this.renderSessionSidebar();
      }
      return;
    }

    this.isWideSessionLayout = isWide;
    this.viewContainerEl.toggleClass('claudian-wide-session-layout', isWide);

    if (isWide) {
      this.historyDropdown?.removeClass('visible');
      this.cancelHistoryRendering();
      this.renderSessionSidebar();
      return;
    }

    this.stopSessionSidebarResize();
    this.cancelSessionSidebarRendering();
    this.retainPinnedProvisionalTabs();
    void this.tabManager?.discardProvisionalTabs().catch(() => {
      new Notice('Failed to close the provisional session preview');
    });
  }

  private async openHistoryConversation(conversationId: string): Promise<void> {
    await this.tabManager?.openConversation(conversationId);
    this.historyDropdown?.removeClass('visible');
    this.cancelHistoryRendering();
  }

  private async openHistoryConversationInNewTab(
    conversationId: string,
    activate = true,
  ): Promise<void> {
    await this.tabManager?.openConversation(conversationId, {
      preferNewTab: true,
      activate,
    });
    this.historyDropdown?.removeClass('visible');
    this.cancelHistoryRendering();
  }

  private async openSessionConversation(
    conversationId: string,
    activate = true,
  ): Promise<void> {
    if (!this.tabManager) return;

    const localTab = this.findTabWithConversation(conversationId);
    const crossViewResult = localTab
      ? null
      : this.plugin.findConversationAcrossViews(conversationId);
    if (localTab || (crossViewResult && crossViewResult.view !== this)) {
      await this.tabManager.openConversation(conversationId);
      this.retainPinnedConversationTab(conversationId);
      return;
    }

    await this.tabManager.openConversation(conversationId, {
      preferNewTab: true,
      activate,
      provisional: true,
    });
    this.retainPinnedConversationTab(conversationId);
  }

  private retainPinnedConversationTab(conversationId: string): void {
    if (!this.plugin.getConversationSync(conversationId)?.isPinned) return;

    for (const tab of this.tabManager?.getAllTabs() ?? []) {
      if (tab.conversationId === conversationId) {
        commitProvisionalTab(tab);
      }
    }
  }

  private cancelHistoryRendering(): void {
    this.historyRenderAbortController?.abort();
    this.historyRenderAbortController = null;
  }

  private cancelSessionSidebarRendering(): void {
    this.sessionSidebarRenderAbortController?.abort();
    this.sessionSidebarRenderAbortController = null;
  }

  private getHistoryConversationStatus(conversationId: string): HistoryConversationStatus {
    const activeTab = this.tabManager?.getActiveTab();
    if (activeTab?.conversationId === conversationId) {
      return {
        openState: 'current',
        isRunning: activeTab.state.isStreaming,
        location: 'current-view',
        tabIndex: this.getHistoryTabIndex(activeTab),
      };
    }

    const localTab = this.findTabWithConversation(conversationId);
    if (localTab) {
      return {
        openState: 'open',
        isRunning: localTab.state.isStreaming,
        location: 'current-view',
        tabIndex: this.getHistoryTabIndex(localTab),
      };
    }

    const crossViewResult = this.plugin.findConversationAcrossViews(conversationId);
    if (crossViewResult && crossViewResult.view !== this) {
      const crossViewTab = crossViewResult.view.getTabManager()?.getTab(crossViewResult.tabId);
      return {
        openState: 'open',
        isRunning: crossViewTab?.state.isStreaming ?? false,
        location: 'other-view',
      };
    }

    return {
      openState: 'closed',
      isRunning: false,
      location: 'current-view',
    };
  }

  private findTabWithConversation(conversationId: string): TabData | null {
    const tabs = this.tabManager?.getAllTabs() ?? [];
    return tabs.find(tab => tab.conversationId === conversationId) ?? null;
  }

  private getHistoryTabIndex(tab: TabData): number | undefined {
    const index = this.tabManager?.getAllTabs().findIndex(candidate => candidate.id === tab.id) ?? -1;
    return index >= 0 ? index + 1 : undefined;
  }

  // ============================================
  // Event Wiring
  // ============================================

  private wireEventHandlers(): void {
    const activeDocument = this.containerEl.ownerDocument;

    // Document-level click to close dropdowns
    this.registerDomEvent(activeDocument, 'click', () => {
      this.historyDropdown?.removeClass('visible');
    });

    // View-level Shift+Tab to toggle plan mode (works from any focused element)
    this.registerDomEvent(this.containerEl, 'keydown', (e: KeyboardEvent) => {
      if (e.key === 'Tab' && e.shiftKey && !e.isComposing) {
        e.preventDefault();
        const activeTab = this.tabManager?.getActiveTab();
        if (!activeTab) return;
        const providerId = getTabProviderId(activeTab, this.plugin);
        if (!ProviderRegistry.getCapabilities(providerId).supportsPlanMode) return;
        commitProvisionalTab(activeTab);
        const current = ProviderSettingsCoordinator.getProviderSettingsSnapshot(
          this.plugin.settings,
          providerId,
        ).permissionMode as string;
        if (current === 'plan') {
          const restoreMode = activeTab.state.prePlanPermissionMode ?? 'normal';
          void updatePlanModeUI(activeTab, this.plugin, restoreMode, { syncExecution: true })
            .finally(() => {
              const activeMode = ProviderSettingsCoordinator.getProviderSettingsSnapshot(
                this.plugin.settings,
                providerId,
              ).permissionMode;
              if (activeMode !== 'plan') {
                activeTab.state.prePlanPermissionMode = null;
              }
            })
            .catch((error: unknown) => {
              new Notice(error instanceof Error ? error.message : 'Failed to change permission mode.');
            });
        } else {
          activeTab.state.prePlanPermissionMode = current;
          void updatePlanModeUI(activeTab, this.plugin, 'plan', { syncExecution: true }).catch((error: unknown) => {
            const activeMode = ProviderSettingsCoordinator.getProviderSettingsSnapshot(
              this.plugin.settings,
              providerId,
            ).permissionMode;
            if (activeMode !== 'plan') {
              activeTab.state.prePlanPermissionMode = null;
            }
            new Notice(error instanceof Error ? error.message : 'Failed to change permission mode.');
          });
        }
      }
    });

    // View scopes are the Obsidian-owned boundary for main-area tab hotkeys.
    // Returning false consumes Escape before Obsidian uses it for pane navigation.
    this.scope = new Scope(this.app.scope);
    this.scope.register([], 'Escape', (e: KeyboardEvent) => {
      if (e.isComposing) return;
      if (!e.defaultPrevented) {
        const activeTab = this.tabManager?.getActiveTab();
        if (activeTab?.state.isStreaming) {
          activeTab.controllers.inputController?.cancelStreaming();
        }
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

    this.eventRefs.push(
      this.plugin.app.vault.on('create', () => this.mentionCacheCoordinator?.markStructureDirty()),
      this.plugin.app.vault.on('delete', () => this.mentionCacheCoordinator?.markStructureDirty()),
      this.plugin.app.vault.on('rename', () => this.mentionCacheCoordinator?.markStructureDirty()),
      this.plugin.app.vault.on('modify', () => this.mentionCacheCoordinator?.markFilesDirty())
    );

    // File open event
    this.registerEvent(
      this.plugin.app.workspace.on('file-open', (file) => {
        if (file) {
          this.tabManager?.getActiveTab()?.ui.fileContextManager?.handleFileOpen(file);
        }
      })
    );

    // Click outside to close mention dropdown
    this.registerDomEvent(activeDocument, 'click', (e) => {
      const activeTab = this.tabManager?.getActiveTab();
      if (activeTab) {
        const fcm = activeTab.ui.fileContextManager;
        if (fcm && !fcm.containsElement(e.target as Node) && e.target !== activeTab.dom.inputEl) {
          fcm.hideMentionDropdown();
        }
      }
    });
  }

  // ============================================
  // Current tab persistence
  // ============================================

  private async restoreCurrentTab(): Promise<void> {
    if (!this.tabManager) return;

    const persistedState = await this.plugin.storage.getTabManagerState();
    const currentTab = persistedState?.openTabs.find(
      tab => tab.tabId === persistedState.activeTabId,
    );
    if (currentTab) {
      await this.tabManager.createTab(currentTab.conversationId, currentTab.tabId);
      return;
    }

    await this.tabManager.createTab();
  }

  private persistCurrentTabState(): void {
    const state = this.getPersistedCurrentTabState();
    if (state) this.tabStatePersistence?.update(state);
  }

  getPersistedCurrentTabState(): AppTabManagerState | null {
    const activeTab = this.tabManager?.getActiveTab();
    if (!activeTab) return null;

    return {
      openTabs: [{
        tabId: activeTab.id,
        conversationId: activeTab.conversationId,
      }],
      activeTabId: activeTab.id,
    };
  }

  /** Flushes the current tab identity before view or plugin shutdown. */
  async flushCurrentTabState(): Promise<void> {
    const state = this.getPersistedCurrentTabState();
    if (!state || !this.tabStatePersistence) return;
    this.tabStatePersistence.update(state);
    await this.tabStatePersistence.flush();
  }

  // ============================================
  // Public API
  // ============================================

  /** Gets the currently active tab. */
  getActiveTab(): TabData | null {
    return this.tabManager?.getActiveTab() ?? null;
  }

  /** Focuses the active tab's composer. */
  focusActiveInput(): void {
    this.tabManager?.getActiveTab()?.dom.inputEl.focus();
  }

  /** Appends text to the active composer without sending it. */
  appendToActiveInput(text: string): boolean {
    const activeTab = this.tabManager?.getActiveTab();
    const inputEl = activeTab?.dom.inputEl;
    if (!inputEl || !text) return false;

    commitProvisionalTab(activeTab);

    const currentValue = inputEl.value;
    const separator = currentValue && !/\s$/.test(currentValue) ? ' ' : '';
    inputEl.value = `${currentValue}${separator}${text}`;

    const cursorPosition = inputEl.value.length;
    inputEl.selectionStart = cursorPosition;
    inputEl.selectionEnd = cursorPosition;

    const EventConstructor = inputEl.ownerDocument.defaultView?.Event ?? Event;
    inputEl.dispatchEvent(new EventConstructor('input', { bubbles: true }));
    inputEl.focus();
    return true;
  }

  notifyConversationListChanged(): void {
    this.updateHistoryDropdown();
  }

  private notifyConversationNavigationChanged(): void {
    this.updateHistoryDropdown();
    for (const view of this.plugin.getAllViews()) {
      if (view !== this) {
        view.notifyConversationListChanged();
      }
    }
  }

  /** Gets the tab manager. */
  getTabManager(): TabManager | null {
    return this.tabManager;
  }

  /** Gets shared view controls that should preserve active tab selection context. */
  getSharedSelectionFocusScopeEls(): HTMLElement[] {
    return [
      this.inputNavRowHostEl,
    ].filter((el): el is HTMLElement => el !== null);
  }
}
