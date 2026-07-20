import type { EventRef, WorkspaceLeaf } from 'obsidian';
import { ItemView, Notice, Scope, setIcon } from 'obsidian';

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
import { createProviderIconSvg } from '../../shared/icons';
import {
  cancelScheduledAnimationFrame,
  scheduleAnimationFrame,
  type ScheduledAnimationFrame,
} from '../../utils/animationFrame';
import type { FeatureHost } from '../FeatureHost';
import type { HistoryConversationStatus } from './controllers/ConversationController';
import { MentionCacheCoordinator } from './services/MentionCacheCoordinator';
import { TabStatePersistenceCoordinator } from './services/TabStatePersistenceCoordinator';
import {
  getTabProviderId,
  onProviderAvailabilityChanged,
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

export class ClaudianView extends ItemView {
  private plugin: FeatureHost;

  // Tab management
  private tabManager: TabManager | null = null;
  private mentionCacheCoordinator: MentionCacheCoordinator | null = null;
  private tabBar: TabBar | null = null;
  private tabBarContainerEl: HTMLElement | null = null;
  private tabContentEl: HTMLElement | null = null;
  private navRowContent: HTMLElement | null = null;
  private inputFooterEl: HTMLElement | null = null;
  private inputNavRowHostEl: HTMLElement | null = null;
  private activeInputSlotEl: HTMLElement | null = null;
  private activeInputTabId: TabId | null = null;

  // DOM Elements
  private viewContainerEl: HTMLElement | null = null;
  private logoEl: HTMLElement | null = null;
  private newTabButtonEl: HTMLElement | null = null;

  // Header elements
  private historyDropdown: HTMLElement | null = null;
  private historyRenderAbortController: AbortController | null = null;

  // Event refs for cleanup
  private eventRefs: EventRef[] = [];

  // Debouncing for tab bar updates
  private pendingTabBarUpdate: ScheduledAnimationFrame | null = null;

  private tabStatePersistence: TabStatePersistenceCoordinator;

  constructor(leaf: WorkspaceLeaf, plugin: FeatureHost) {
    super(leaf);
    this.plugin = plugin;
    this.tabStatePersistence = new TabStatePersistenceCoordinator(
      state => this.plugin.persistTabManagerState(state),
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
  refreshModelSelector(): void {
    for (const tab of this.tabManager?.getAllTabs() ?? []) {
      onProviderAvailabilityChanged(tab, this.plugin);
      const providerId = getTabProviderId(tab, this.plugin);
      const conversation = tab.conversationId
        ? this.plugin.getConversationSync(tab.conversationId)
        : null;
      const modelOverride = conversation
        ? resolveConversationModel(this.plugin.settings, providerId, conversation).model
        : tab.lifecycleState === 'blank'
        ? tab.draftModel
        : tab.service?.getAuxiliaryModel?.() ?? null;
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

    this.tabManager?.primeProviderRuntime();
  }

  invalidateProviderCommandCaches(providerIds?: ProviderId[]): void {
    this.tabManager?.invalidateProviderCommandCaches(providerIds);
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

    const header = this.viewContainerEl.createDiv({ cls: 'claudian-header' });
    this.buildHeader(header);

    this.navRowContent = this.buildNavRowContent();
    this.tabContentEl = this.viewContainerEl.createDiv({ cls: 'claudian-tab-content-container' });
    this.buildInputFooter();

    this.tabManager = new TabManager(
      this.plugin,
      this.tabContentEl,
      this,
      {
        onTabCreated: () => {
          this.updateTabBar();
          this.updateHistoryDropdown();
          this.updateInputLocation();
          this.persistTabState();
          this.syncProviderBrandColor();
        },
        onActiveTabChanged: () => {
          this.updateTabBar();
          this.updateHistoryDropdown();
          this.updateInputLocation();
          this.syncProviderBrandColor();
        },
        onTabSwitched: () => {
          this.updateTabBar();
          this.updateHistoryDropdown();
          this.updateInputLocation();
          this.persistTabState();
          this.syncProviderBrandColor();
        },
        onTabClosed: () => {
          this.updateTabBar();
          this.updateHistoryDropdown();
          this.updateInputLocation();
          this.persistTabState();
        },
        onTabStreamingChanged: () => {
          this.updateTabBar();
          this.updateHistoryDropdown();
        },
        onTabTitleChanged: () => this.updateTabBar(),
        onTabAttentionChanged: () => this.updateTabBar(),
        onTabConversationChanged: () => {
          this.updateTabBar();
          this.updateHistoryDropdown();
          this.persistTabState();
          this.syncProviderBrandColor();
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
    await this.restoreOrCreateTabs();
    this.syncProviderBrandColor();
    this.attachNavRowContentToInputFooter();
    this.updateInputLocation();
    this.updateTabBarVisibility();
  }

  async onClose() {
    this.cancelHistoryRendering();
    if (this.pendingTabBarUpdate !== null) {
      cancelScheduledAnimationFrame(this.pendingTabBarUpdate);
      this.pendingTabBarUpdate = null;
    }

    for (const ref of this.eventRefs) {
      this.plugin.app.vault.offref(ref);
    }
    this.eventRefs = [];

    try {
      await this.persistTabStateImmediate();
    } catch {
      // The storage boundary already reports the failure. View teardown must still complete cleanly.
    } finally {
      this.tabStatePersistence.dispose();
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

  private buildHeader(header: HTMLElement): void {
    const titleEl = header.createDiv({ cls: 'claudian-title' });

    this.logoEl = titleEl.createSpan({ cls: 'claudian-logo' });
    this.syncHeaderLogo(DEFAULT_CHAT_PROVIDER_ID);

    titleEl.createEl('h4', { text: 'Claudian', cls: 'claudian-title-text' });
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
      onNewTab: () => {
        void this.createNewTab().catch(() => new Notice('Failed to create tab'));
      },
      onTitleExpansionChanged: () => this.persistTabState(),
    });

    const navActionsEl = wrapper.createDiv({ cls: 'claudian-input-nav-actions' });

    this.newTabButtonEl = navActionsEl.createDiv({ cls: 'claudian-input-nav-btn claudian-new-tab-btn' });
    setIcon(this.newTabButtonEl, 'square-plus');
    this.newTabButtonEl.setAttribute('aria-label', 'New tab');
    this.newTabButtonEl.addEventListener('click', () => {
      void this.createNewTab().catch(() => new Notice('Failed to create tab'));
    });

    const newBtn = navActionsEl.createDiv({ cls: 'claudian-input-nav-btn' });
    setIcon(newBtn, 'square-pen');
    newBtn.setAttribute('aria-label', 'New conversation');
    newBtn.addEventListener('click', () => {
      void (async () => {
        await this.tabManager?.createNewConversation();
        this.updateHistoryDropdown();
      })().catch(() => new Notice('Failed to create conversation'));
    });

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

  private buildInputFooter(): void {
    if (!this.viewContainerEl) return;

    this.inputFooterEl = this.viewContainerEl.createDiv({ cls: 'claudian-input-footer' });
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
    if (!tab) {
      const maxTabs = this.plugin.settings.maxTabs ?? 3;
      new Notice(`Maximum ${maxTabs} tabs allowed`);
      this.updateTabBarVisibility();
      return;
    }
    this.updateTabBarVisibility();
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
    if (!this.newTabButtonEl || !this.tabManager) return;

    const canCreateTab = this.tabManager.canCreateTab();
    this.newTabButtonEl.toggleClass('claudian-hidden', !canCreateTab);
    if (canCreateTab) {
      this.newTabButtonEl.removeAttribute('aria-disabled');
      this.newTabButtonEl.removeAttribute('aria-hidden');
      return;
    }

    this.newTabButtonEl.setAttribute('aria-disabled', 'true');
    this.newTabButtonEl.setAttribute('aria-hidden', 'true');
  }

  /** Sets `data-provider` on the root container so CSS brand color follows the active provider. */
  private syncProviderBrandColor(): void {
    if (!this.viewContainerEl) return;
    const activeTab = this.tabManager?.getActiveTab();
    const providerId = activeTab ? getTabProviderId(activeTab, this.plugin) : DEFAULT_CHAT_PROVIDER_ID;
    this.viewContainerEl.dataset.provider = providerId;
    this.syncHeaderLogo(providerId);
  }

  /** Rebuilds the header logo SVG to match the given provider. */
  private syncHeaderLogo(providerId: ProviderId): void {
    if (!this.logoEl) return;
    const icon = ProviderRegistry.getChatUIConfig(providerId).getProviderIcon?.();
    if (!icon) return;
    const existing = this.logoEl.querySelector('svg');
    if (existing?.getAttribute('data-provider') === providerId) return;
    this.logoEl.empty();
    createProviderIconSvg(icon, {
      dataProvider: providerId,
      height: 18,
      parent: this.logoEl,
      width: 18,
    });
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
  private historyDropdownRendered = false;

  private updateHistoryDropdown(): void {
    this.historyDropdownDirty = true;
    if (this.historyDropdown?.hasClass('visible')) {
      this.renderHistoryDropdown();
    }
  }

  private renderHistoryDropdown(): void {
    if (!this.historyDropdown || !this.historyDropdownDirty) return;

    this.cancelHistoryRendering();
    const abortController = new AbortController();
    this.historyRenderAbortController = abortController;

    const span = this.historyDropdownRendered ? null : StartupProfiler.start('history-list-render');
    this.historyDropdownRendered = true;

    try {
      this.historyDropdown.empty();

      const activeTab = this.tabManager?.getActiveTab();
      const conversationController = activeTab?.controllers.conversationController;

      if (conversationController) {
        conversationController.renderHistoryDropdown(this.historyDropdown, {
          onSelectConversation: (id) => this.openHistoryConversation(id),
          onOpenConversationInNewTab: (id, activate) =>
            this.openHistoryConversationInNewTab(id, activate),
          getConversationStatus: (id) => this.getHistoryConversationStatus(id),
          signal: abortController.signal,
        });
      }
      this.historyDropdownDirty = false;
    } finally {
      if (span) {
        StartupProfiler.finish(span);
      }
    }
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

  private cancelHistoryRendering(): void {
    this.historyRenderAbortController?.abort();
    this.historyRenderAbortController = null;
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
        const current = ProviderSettingsCoordinator.getProviderSettingsSnapshot(
          this.plugin.settings,
          providerId,
        ).permissionMode as string;
        if (current === 'plan') {
          const restoreMode = activeTab.state.prePlanPermissionMode ?? 'normal';
          void updatePlanModeUI(activeTab, this.plugin, restoreMode)
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
          void updatePlanModeUI(activeTab, this.plugin, 'plan').catch((error: unknown) => {
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
  // Persistence
  // ============================================

  private async restoreOrCreateTabs(): Promise<void> {
    const span = StartupProfiler.start('tab-restore');
    try {
      if (!this.tabManager) return;

      // Try to restore from persisted state
      const persistedState = await this.plugin.storage.getTabManagerState();
      if (persistedState && persistedState.openTabs.length > 0) {
        StartupProfiler.recordCount('restored-tab-count', persistedState.openTabs.length);
        await StartupProfiler.runAsync('tab-restore-internal', () => this.tabManager!.restoreState(persistedState));
        this.tabBar?.setExpandedTitleTabIds(persistedState.expandedTitleTabIds ?? []);
        this.updateTabBar();
        return;
      }

      // Fallback: create a new empty tab
      await this.tabManager.createTab();
    } finally {
      StartupProfiler.finish(span);
    }
  }

  private persistTabState(): void {
    const state = this.getPersistedTabState();
    if (!state) return;
    this.tabStatePersistence.update(state);
  }

  /** Force immediate persistence (for onClose/onunload). */
  private async persistTabStateImmediate(): Promise<void> {
    const state = this.getPersistedTabState();
    if (!state) return;
    this.tabStatePersistence.update(state);
    await this.tabStatePersistence.flush();
  }

  getPersistedTabState(): AppTabManagerState | null {
    if (!this.tabManager) return null;

    const state = this.tabManager.getPersistedState();
    const openTabIds = new Set(state.openTabs.map(tab => tab.tabId));
    const expandedTitleTabIds = (this.tabBar?.getExpandedTitleTabIds() ?? [])
      .filter(tabId => openTabIds.has(tabId));

    return {
      ...state,
      ...(expandedTitleTabIds.length > 0 ? { expandedTitleTabIds } : {}),
    };
  }

  // ============================================
  // Public API
  // ============================================

  /** Gets the currently active tab. */
  getActiveTab(): TabData | null {
    return this.tabManager?.getActiveTab() ?? null;
  }

  /** Appends text to the active composer without sending it. */
  appendToActiveInput(text: string): boolean {
    const inputEl = this.tabManager?.getActiveTab()?.dom.inputEl;
    if (!inputEl || !text) return false;

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
