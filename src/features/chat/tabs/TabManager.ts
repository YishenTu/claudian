import { Notice } from 'obsidian';

import { StartupProfiler } from '../../../core/performance/StartupProfiler';
import type { ProviderCommandDiscoveryResult } from '../../../core/providers/commands/ProviderCommandDiscoveryResult';
import { normalizeProviderCommandDiscoveryItems } from '../../../core/providers/commands/ProviderCommandDiscoveryResult';
import { ProviderCommandDiscoveryStore } from '../../../core/providers/commands/ProviderCommandDiscoveryStore';
import type { ProviderCommandEntry } from '../../../core/providers/commands/ProviderCommandEntry';
import { getRuntimeEnvironmentVariables } from '../../../core/providers/providerEnvironment';
import { ProviderRegistry } from '../../../core/providers/ProviderRegistry';
import { ProviderWorkspaceRegistry } from '../../../core/providers/ProviderWorkspaceRegistry';
import type {
  ProviderId,
} from '../../../core/providers/types';
import type { Conversation, SlashCommand } from '../../../core/types';
import { t } from '../../../i18n/i18n';
import { chooseForkTarget } from '../../../shared/modals/ForkTargetModal';
import { throwIfAborted, toAbortError } from '../../../utils/abort';
import { scheduleAnimationFrame } from '../../../utils/animationFrame';
import { revealWorkspaceLeaf } from '../../../utils/obsidianCompat';
import { getVaultPath } from '../../../utils/path';
import type { FeatureHost } from '../../FeatureHost';
import { getTabProviderId } from './providerResolution';
import {
  activateTab,
  createTab,
  deactivateTab,
  destroyTab,
  type ForkContext,
  getTabTitle,
  initializeTabControllers,
  initializeTabUI,
  onProviderAvailabilityChanged,
  refreshTabWorkspaceServices,
  wireTabInputEvents,
} from './Tab';
import {
  type TabBarItem,
  type TabData,
  type TabId,
  type TabManagerCallbacks,
  type TabManagerInterface,
  type TabManagerViewHost,
} from './types';

function isTabManagerViewHost(value: unknown): value is TabManagerViewHost {
  return !!value
    && typeof value === 'object'
    && 'getTabManager' in (value as Record<string, unknown>);
}

type CreateTabOptions = {
  activate?: boolean;
  draftModel?: string;
  lifecycleState?: Extract<TabData['lifecycleState'], 'provisional' | 'cold'>;
};

type OpenConversationOptions = {
  preferNewTab?: boolean;
  activate?: boolean;
  provisional?: boolean;
};

type ProviderRuntimeCommandCacheEntry = {
  result: ProviderCommandDiscoveryResult<SlashCommand>;
  key: string;
};

type ProviderWarmupContext = {
  coordinatorState: 'absent' | 'idle' | 'active' | 'stale';
  conversation: Conversation | null;
  externalContextPaths: string[];
  hasResumableNativeSeed: boolean;
  plugin: FeatureHost['providerHost'];
  tab: {
    conversationId: string | null;
    draftModel: string | null;
    lifecycleState: TabData['lifecycleState'];
    providerId: ProviderId;
  };
  warmupMode: 'none' | 'commands' | 'execution';
};

type ProviderCommandContext = ProviderWarmupContext & {
  cacheKey: string;
  commandContextRevision: number;
  providerGeneration: number;
  resourceGeneration: number;
};

type ProviderCommandWarmupEntry = {
  abortController: AbortController;
  key: string;
  promise: Promise<ProviderCommandDiscoveryResult<SlashCommand>>;
};

type SdkCommandDiscovery = {
  result: ProviderCommandDiscoveryResult<SlashCommand>;
  commandSnapshot?: readonly SlashCommand[];
};

/**
 * TabManager coordinates multiple chat tabs.
 */
export class TabManager implements TabManagerInterface {
  private plugin: FeatureHost;
  private containerEl: HTMLElement;
  private view: TabManagerViewHost;

  private tabs: Map<TabId, TabData> = new Map();
  private activeTabId: TabId | null = null;
  private callbacks: TabManagerCallbacks;
  private providerRuntimeCommandWarmups = new Map<TabId, ProviderCommandWarmupEntry>();
  private providerRuntimeCommandCache = new Map<TabId, ProviderRuntimeCommandCacheEntry>();
  private providerCommandDiscoveryStores = new Map<
    TabId,
    ProviderCommandDiscoveryStore<ProviderCommandEntry>
  >();
  private providerResourceGenerations = new Map<ProviderId, number>();
  private tabCommandContextRevisions = new Map<TabId, number>();
  private tabActivationRevisions = new Map<TabId, number>();

  /** Guard to prevent concurrent tab switches. */
  private isSwitchingTab = false;
  private pendingSwitchTabId: TabId | null = null;
  private readonly tabSwitchIdleWaiters = new Set<() => void>();
  private tabSwitchRequestRevision = 0;
  private conversationNavigationRequestRevision = 0;
  private conversationNavigationTail: Promise<void> = Promise.resolve();
  private provisionalCleanupPromise: Promise<void> | null = null;
  private profiledFirstHydration = false;
  private destroyed = false;

  constructor(
    plugin: FeatureHost,
    containerEl: HTMLElement,
    view: TabManagerViewHost,
    callbacks?: TabManagerCallbacks,
  );
  constructor(
    plugin: FeatureHost,
    legacyArg: unknown,
    containerEl: HTMLElement,
    view: TabManagerViewHost,
    callbacks?: TabManagerCallbacks,
  );
  constructor(
    plugin: FeatureHost,
    arg2: unknown,
    arg3: HTMLElement | TabManagerViewHost,
    arg4?: TabManagerViewHost | TabManagerCallbacks,
    arg5: TabManagerCallbacks = {},
  ) {
    this.plugin = plugin;

    if (isTabManagerViewHost(arg3)) {
      this.containerEl = arg2 as HTMLElement;
      this.view = arg3;
      this.callbacks = (arg4 as TabManagerCallbacks | undefined) ?? {};
      return;
    }

    this.containerEl = arg3;
    this.view = arg4 as TabManagerViewHost;
    this.callbacks = arg5;
  }

  // ============================================
  // Tab Lifecycle
  // ============================================

  /**
   * Creates a new tab.
   * @param conversationId Optional conversation to load into the tab.
   * @param tabId Optional caller-provided runtime tab ID.
   * @param options Controls whether the new tab becomes active immediately.
   * @returns The created runtime tab.
   */
  async createTab(
    conversationId?: string | null,
    tabId?: TabId,
    options: CreateTabOptions = {},
  ): Promise<TabData | null> {
    const { activate = true, draftModel, lifecycleState = 'cold' } = options;

    const conversation = conversationId
      ? this.plugin.getCachedConversation(conversationId)
      : undefined;

    // Inherit the active tab's provider so the new blank tab picks up its model
    const activeTab = this.getActiveTab();
    const defaultProviderId = conversation
      ? undefined
      : (activeTab ? getTabProviderId(activeTab, this.plugin) : undefined);

    const tab = createTab({
      plugin: this.plugin,
      containerEl: this.containerEl,
      conversation: conversation ?? undefined,
      tabId,
      ...(typeof draftModel === 'string' ? { draftModel } : {}),
      lifecycleState,
      defaultProviderId,
      onStreamingChanged: (isStreaming) => {
        this.callbacks.onTabStreamingChanged?.(tab.id, isStreaming);
        if (!isStreaming) tab.executionCoordinator?.notifyMayCool();
      },
      onRewindingChanged: (isRewinding) => {
        this.callbacks.onTabRewindingChanged?.(tab.id, isRewinding);
        if (!isRewinding) tab.executionCoordinator?.notifyMayCool();
      },
      onTitleChanged: (title) => {
        this.callbacks.onTabTitleChanged?.(tab.id, title);
      },
      onAttentionChanged: (attention) => {
        this.callbacks.onTabAttentionChanged?.(tab.id, attention);
        if (attention?.kind !== 'action-required') {
          tab.executionCoordinator?.notifyMayCool();
        }
      },
      captureReviewableSettlement: () => {
        const shouldReport = this.isTabAlive(tab) && this.activeTabId !== tab.id;
        const activationRevision = this.tabActivationRevisions.get(tab.id) ?? 0;
        return () => {
          if (
            shouldReport
            && this.isTabAlive(tab)
            && (this.tabActivationRevisions.get(tab.id) ?? 0) === activationRevision
          ) {
            tab.state.markReviewRequired();
          }
        };
      },
      onConversationIdChanged: (conversationId) => {
        this.bumpTabCommandContextRevision(tab.id);
        // Sync tab.conversationId when conversation is lazily created
        tab.conversationId = conversationId;
        this.callbacks.onTabConversationChanged?.(tab.id, conversationId);
      },
    });

    this.tabCommandContextRevisions.set(tab.id, 0);
    this.tabActivationRevisions.set(tab.id, 0);
    this.ensureProviderCommandDiscoveryStore(tab.id);

    // Initialize UI components with provider catalog
    initializeTabUI(tab, this.plugin, {
      getProviderCatalogConfig: () => this.getProviderCatalogConfig(tab),
      onCommandContextChanged: () => {
        this.bumpTabCommandContextRevision(tab.id);
      },
      onProviderChanged: async (providerId) => {
        this.bumpTabCommandContextRevision(tab.id);
        await this.ensureTabWorkspaceServices(tab, providerId, 'provider-selection');
        this.callbacks.onTabProviderChanged?.(tab.id, providerId);
      },
    });

    initializeTabControllers(
      tab,
      this.plugin,
      this.view,
      (forkContext) => this.handleForkRequest(forkContext),
      (conversationId) => this.openConversation(conversationId),
      () => this.getProviderCatalogConfig(tab),
    );

    // Wire input event handlers
    wireTabInputEvents(tab, this.plugin);

    this.tabs.set(tab.id, tab);
    this.callbacks.onTabCreated?.(tab);

    if (activate || !this.activeTabId) {
      await this.switchToTab(tab.id);
    }

    return tab;
  }

  /**
   * Switches to a different tab.
   * @param tabId The tab to switch to.
   */
  async switchToTab(tabId: TabId): Promise<void> {
    const tab = this.tabs.get(tabId);
    if (!tab) {
      return;
    }
    this.tabSwitchRequestRevision += 1;

    // Guard against concurrent tab switches
    if (this.isSwitchingTab) {
      this.pendingSwitchTabId = tabId;
      return;
    }

    this.isSwitchingTab = true;
    const previousTabId = this.activeTabId;

    try {
      // Deactivate current tab
      if (previousTabId && previousTabId !== tabId) {
        const currentTab = this.tabs.get(previousTabId);
        if (currentTab) {
          deactivateTab(currentTab);
        }
      }

      // Activate new tab
      this.activeTabId = tabId;
      this.tabActivationRevisions.set(
        tabId,
        (this.tabActivationRevisions.get(tabId) ?? 0) + 1,
      );
      activateTab(tab);
      tab.state.acknowledgeReview();
      this.callbacks.onActiveTabChanged?.(previousTabId, tabId);

      const providerId = tab.providerId;
      const needsHydration = !!tab.conversationId && tab.hydrationState !== 'ready';
      if (needsHydration) {
        tab.hydrationState = 'loading';
        this.renderTabHydrationState(tab);
        await this.waitForTabPaint(tab);
        if (!this.isTabAlive(tab)) return;
      }

      try {
        if (!await this.ensureTabWorkspaceServices(tab, providerId, 'tab-activation')) {
          return;
        }

        // Load conversation if not already loaded
        if (needsHydration && tab.conversationId) {
          const span = this.profiledFirstHydration ? null : StartupProfiler.start('active-hydration');
          this.profiledFirstHydration = true;
          try {
            await tab.controllers.conversationController?.switchTo(tab.conversationId);
          } finally {
            if (span) {
              StartupProfiler.finish(span);
            }
          }
          if (!this.isTabAlive(tab)) return;
          tab.hydrationState = 'ready';
        } else if (tab.conversationId && tab.state.messages.length > 0) {
          tab.hydrationState = 'ready';
        } else if (!tab.conversationId && tab.state.messages.length === 0) {
          // New tab with no conversation - initialize welcome greeting
          tab.controllers.conversationController?.initializeWelcome();
          tab.hydrationState = 'ready';
        }
      } catch (error) {
        if (!this.isTabAlive(tab)) return;
        tab.hydrationState = 'failed';
        this.renderTabHydrationState(tab, error);
        return;
      }

      if (!this.isTabAlive(tab)) return;
      this.callbacks.onTabSwitched?.(previousTabId, tabId);
    } finally {
      this.isSwitchingTab = false;
      const pendingTabId = this.pendingSwitchTabId;
      this.pendingSwitchTabId = null;
      if (pendingTabId && pendingTabId !== this.activeTabId) {
        await this.switchToTab(pendingTabId);
      }
      this.resolveTabSwitchIdleWaitersIfIdle();
    }
  }

  getTabSwitchRequestRevision(): number {
    return this.tabSwitchRequestRevision;
  }

  async waitForTabSwitchIdle(): Promise<void> {
    while (this.isSwitchingTab) {
      await new Promise<void>((resolve) => {
        this.tabSwitchIdleWaiters.add(resolve);
      });
    }
  }

  private resolveTabSwitchIdleWaitersIfIdle(): void {
    if (this.isSwitchingTab || this.pendingSwitchTabId) return;

    const waiters = [...this.tabSwitchIdleWaiters];
    this.tabSwitchIdleWaiters.clear();
    for (const resolve of waiters) {
      resolve();
    }
  }

  /**
   * Closes a tab.
   * @param tabId The tab to close.
   * @param force If true, close even if streaming.
   * @returns True if the tab was closed.
   */
  async closeTab(tabId: TabId, force = false): Promise<boolean> {
    const tab = this.tabs.get(tabId);
    if (!tab) {
      return false;
    }

    // Rewind is a provider/local-state transaction and cannot be interrupted by teardown.
    if (tab.state.isRewinding) {
      return false;
    }

    // Don't close if streaming unless forced
    if (tab.state.isStreaming && !force) {
      return false;
    }

    // If this is the last tab and it's already empty (no conversation),
    // don't close it - it's already a blank draft container.
    if (this.tabs.size === 1 && !tab.conversationId && tab.state.messages.length === 0) {
      return false;
    }

    // Prevent in-flight hydration from mutating this tab while close awaits persistence.
    tab.lifecycleState = 'closing';
    this.providerCommandDiscoveryStores.get(tabId)?.invalidate();
    this.cancelProviderRuntimeCommandWarmup(tabId);

    // Save conversation before closing. Cleanup remains mandatory if save fails.
    let saveError: unknown;
    let didSaveFail = false;
    try {
      await tab.controllers.conversationController?.save();
    } catch (error) {
      didSaveFail = true;
      saveError = error;
    }

    // Capture tab order BEFORE deletion for fallback calculation
    const tabIdsBefore = Array.from(this.tabs.keys());
    const closingIndex = tabIdsBefore.indexOf(tabId);

    // Destroy tab resources (async for proper cleanup)
    await destroyTab(tab);
    this.providerRuntimeCommandCache.delete(tabId);
    this.providerCommandDiscoveryStores.delete(tabId);
    this.tabCommandContextRevisions.delete(tabId);
    this.tabActivationRevisions.delete(tabId);
    this.tabs.delete(tabId);
    const wasActiveTab = this.activeTabId === tabId;
    if (wasActiveTab) {
      this.activeTabId = null;
    }
    this.callbacks.onTabClosed?.(tabId);

    // If we closed the active tab, switch to another
    if (wasActiveTab) {
      if (this.tabs.size > 0) {
        // Fallback strategy: prefer previous tab, except for first tab (go to next)
        const fallbackTabId = closingIndex === 0
          ? tabIdsBefore[1]  // First tab: go to next
          : tabIdsBefore[closingIndex - 1];  // Others: go to previous

        if (fallbackTabId && this.tabs.has(fallbackTabId)) {
          await this.switchToTab(fallbackTabId);
        }
      } else {
        // Create a replacement blank tab.
        await this.createTab();
      }
    }

    if (didSaveFail) {
      throw saveError;
    }
    return true;
  }

  private isTabAlive(tab: TabData): boolean {
    return tab.lifecycleState !== 'closing' && this.tabs.get(tab.id) === tab;
  }

  private waitForTabPaint(tab: TabData): Promise<void> {
    return new Promise(resolve => {
      scheduleAnimationFrame(resolve, tab.dom.contentEl.ownerDocument?.defaultView ?? null);
    });
  }

  private renderTabHydrationState(tab: TabData, error?: unknown): void {
    const messagesEl = tab.dom.messagesEl;
    messagesEl.empty();

    const statusEl = messagesEl.createDiv({ cls: 'claudian-tab-hydration' });
    if (!error) {
      statusEl.createDiv({
        cls: 'claudian-tab-hydration-loading',
        text: 'Loading conversation…',
      });
      return;
    }

    statusEl.createDiv({
      cls: 'claudian-tab-hydration-error',
      text: error instanceof Error ? error.message : 'Failed to load conversation',
    });
    const retryButton = statusEl.createEl('button', {
      cls: 'mod-cta claudian-tab-hydration-retry',
      text: 'Retry',
    });
    retryButton.addEventListener('click', () => {
      if (!this.isTabAlive(tab)) return;
      void this.switchToTab(tab.id);
    });
  }

  // ============================================
  // Tab Queries
  // ============================================

  /** Gets the currently active tab. */
  getActiveTab(): TabData | null {
    return this.activeTabId ? this.tabs.get(this.activeTabId) ?? null : null;
  }

  /** Gets the active tab ID. */
  getActiveTabId(): TabId | null {
    return this.activeTabId;
  }

  /** Gets a tab by ID. */
  getTab(tabId: TabId): TabData | null {
    return this.tabs.get(tabId) ?? null;
  }

  /** Gets all tabs. */
  getAllTabs(): TabData[] {
    return Array.from(this.tabs.values());
  }

  /** Reconciles blank drafts after provider/model availability changes. */
  reconcileProviderAvailability(): void {
    for (const tab of this.tabs.values()) {
      if (onProviderAvailabilityChanged(tab, this.plugin)) {
        this.callbacks.onTabProviderChanged?.(tab.id, tab.providerId);
      }
    }
  }

  /** Gets the number of tabs. */
  getTabCount(): number {
    return this.tabs.size;
  }

  /** Checks if more tabs can be created. */
  canCreateTab(): boolean {
    return true;
  }

  /** Removes replaceable dual-mode previews while retaining cold and warm work. */
  async discardProvisionalTabs(): Promise<void> {
    if (this.destroyed) return;
    if (this.provisionalCleanupPromise) {
      await this.provisionalCleanupPromise;
      return;
    }

    const cleanup = this.discardProvisionalTabsProtected();
    this.provisionalCleanupPromise = cleanup;
    try {
      await cleanup;
    } finally {
      if (this.provisionalCleanupPromise === cleanup) {
        this.provisionalCleanupPromise = null;
      }
    }
  }

  private async discardProvisionalTabsProtected(): Promise<void> {
    await this.invalidateAndDrainConversationNavigation();
    const hasRetainedTab = Array.from(this.tabs.values()).some(
      tab => tab.lifecycleState !== 'provisional' && tab.lifecycleState !== 'closing',
    );
    if (!hasRetainedTab) {
      const activeTab = this.getActiveTab();
      if (activeTab?.lifecycleState === 'provisional') {
        activeTab.lifecycleState = 'cold';
      }
    }

    const provisionalTabIds = Array.from(this.tabs.values())
      .filter(tab => tab.lifecycleState === 'provisional')
      .map(tab => tab.id);
    for (const tabId of provisionalTabIds) {
      await this.closeTab(tabId);
    }
  }

  // ============================================
  // Tab Bar Data
  // ============================================

  /** Gets data for rendering the tab bar. */
  getTabBarItems(): TabBarItem[] {
    const items: TabBarItem[] = [];
    let index = 1;

    for (const tab of this.tabs.values()) {
      items.push({
        id: tab.id,
        index: index++,
        title: getTabTitle(tab, this.plugin),
        providerId: getTabProviderId(tab, this.plugin),
        isActive: tab.id === this.activeTabId,
        isStreaming: tab.state.isStreaming,
        needsAttention: tab.state.needsAttention,
        canClose: !tab.state.isRewinding && (this.tabs.size > 1 || !tab.state.isStreaming),
      });
    }

    return items;
  }

  // ============================================
  // Conversation Management
  // ============================================

  /**
   * Opens a conversation in a new tab or existing tab.
   * @param conversationId The conversation to open.
   * @param options Controls tab creation behavior (backward-compatible with boolean).
   */
  async openConversation(
    conversationId: string,
    options: boolean | OpenConversationOptions = false,
  ): Promise<void> {
    const preferNewTab = typeof options === 'boolean'
      ? options
      : options.preferNewTab ?? false;
    const activate = typeof options === 'boolean'
      ? true
      : options.activate ?? true;
    const provisional = typeof options === 'boolean'
      ? false
      : options.provisional ?? false;

    await this.enqueueConversationNavigation(
      conversationId,
      preferNewTab,
      activate,
      provisional,
    );
  }

  private async enqueueConversationNavigation(
    conversationId: string,
    preferNewTab: boolean,
    activate: boolean,
    provisional: boolean,
  ): Promise<void> {
    if (this.destroyed || this.provisionalCleanupPromise) return;
    const requestRevision = ++this.conversationNavigationRequestRevision;
    const pending = this.conversationNavigationTail
      .catch(() => undefined)
      .then(async () => {
        if (
          this.destroyed
          || requestRevision !== this.conversationNavigationRequestRevision
        ) return;
        await this.openConversationImmediately(
          conversationId,
          preferNewTab,
          activate,
          provisional,
        );
      });
    this.conversationNavigationTail = pending.then(
      () => undefined,
      () => undefined,
    );
    await pending;
  }

  private async invalidateAndDrainConversationNavigation(): Promise<void> {
    this.conversationNavigationRequestRevision += 1;
    await this.conversationNavigationTail;
  }

  private async openConversationImmediately(
    conversationId: string,
    preferNewTab: boolean,
    activate: boolean,
    provisional: boolean,
  ): Promise<void> {

    // Check if conversation is already open in this view's tabs
    for (const tab of this.tabs.values()) {
      if (tab.conversationId === conversationId) {
        await this.switchToTab(tab.id);
        return;
      }
    }

    // Check if conversation is open in another view (split workspace scenario)
    // Compare view references directly (more robust than leaf comparison)
    const crossViewResult = this.plugin.findConversationAcrossViews(conversationId);
    const isSameView = crossViewResult?.view === this.view;
    if (crossViewResult && !isSameView) {
      // Focus the other view and switch to its tab instead of opening duplicate
      await revealWorkspaceLeaf(this.plugin.app.workspace, crossViewResult.view.leaf);
      await crossViewResult.view.getTabManager()?.switchToTab(crossViewResult.tabId);
      return;
    }

    // Open in current tab or new tab
    if (preferNewTab) {
      if (provisional) {
        const previewTab = Array.from(this.tabs.values())
          .find(tab => tab.lifecycleState === 'provisional');
        if (previewTab) {
          await previewTab.controllers.conversationController?.switchTo(conversationId);
          if (this.isTabAlive(previewTab)) {
            previewTab.lifecycleState = 'provisional';
            if (activate) {
              await this.switchToTab(previewTab.id);
            }
          }
          return;
        }
      }
      await this.createTab(conversationId, undefined, {
        activate,
        lifecycleState: provisional ? 'provisional' : 'cold',
      });
    } else {
      // Open in current tab
      // Note: Don't set tab.conversationId here - the onConversationIdChanged callback
      // will sync it after successful switch. Setting it before switchTo() would cause
      // incorrect tab metadata if switchTo() returns early (streaming/switching/creating).
      const activeTab = this.getActiveTab();
      if (activeTab) {
        await activeTab.controllers.conversationController?.switchTo(conversationId);
        if (this.isTabAlive(activeTab)) {
          activeTab.lifecycleState = 'cold';
        }
      }
    }
  }

  /**
   * Creates a new conversation in the active tab.
   */
  async createNewConversation(): Promise<void> {
    const activeTab = this.getActiveTab();
    if (activeTab) {
      await activeTab.controllers.conversationController?.createNew();
      // Sync tab.conversationId with the newly created conversation
      activeTab.conversationId = activeTab.state.currentConversationId;
    }
  }

  invalidateProviderCommandCaches(providerIds?: ProviderId | ProviderId[]): void {
    for (const tab of this.filterTabsByProvider(providerIds, (tab) => getTabProviderId(tab, this.plugin))) {
      this.bumpTabCommandContextRevision(tab.id);
    }
  }

  invalidateProviderResources(
    providerIds: ProviderId | ProviderId[],
    generation: number,
  ): void {
    const ids = Array.isArray(providerIds) ? providerIds : [providerIds];
    for (const providerId of ids) {
      this.providerResourceGenerations.set(
        providerId,
        Math.max(this.getProviderResourceGeneration(providerId), generation),
      );
      ProviderWorkspaceRegistry.getCommandCatalog(providerId)?.setCommandSnapshot([]);
    }

    const filter = new Set(ids);
    for (const tab of this.tabs.values()) {
      const providerId = getTabProviderId(tab, this.plugin);
      if (!filter.has(providerId)) continue;
      this.bumpTabCommandContextRevision(tab.id);
    }
  }

  primeProviderExecution(providerIds?: ProviderId | ProviderId[]): void {
    for (const tab of this.filterTabsByProvider(providerIds, tab => tab.providerId)) {
      this.maybePrimeProviderExecution(tab);
    }
  }

  private *filterTabsByProvider(
    providerIds: ProviderId | ProviderId[] | undefined,
    resolve: (tab: TabData) => ProviderId,
  ): Iterable<TabData> {
    const filter = providerIds
      ? new Set(Array.isArray(providerIds) ? providerIds : [providerIds])
      : null;

    for (const tab of this.tabs.values()) {
      if (filter && !filter.has(resolve(tab))) {
        continue;
      }
      yield tab;
    }
  }

  // ============================================
  // Fork
  // ============================================

  private async handleForkRequest(context: ForkContext): Promise<void> {
    const shouldForkToNewTab = this.callbacks.shouldForkToNewTab?.() ?? false;
    const target = shouldForkToNewTab
      ? 'new-tab'
      : await chooseForkTarget(this.plugin.app);
    if (!target) return;

    if (target === 'new-tab') {
      const tab = await this.forkToNewTab(context);
      if (!tab) return;
      if (!shouldForkToNewTab) {
        new Notice(t('chat.fork.notice'));
      }
    } else {
      const success = await this.forkInCurrentTab(context);
      if (!success) {
        new Notice(t('chat.fork.failed', { error: t('chat.fork.errorNoActiveTab') }));
        return;
      }
      new Notice(t('chat.fork.noticeCurrentTab'));
    }
  }

  async forkToNewTab(context: ForkContext): Promise<TabData | null> {
    const sourceCoordinator = this.getActiveTab()?.executionCoordinator ?? null;
    const conversationId = await this.createForkConversation(context, sourceCoordinator);
    try {
      return await this.createTab(conversationId);
    } catch (error) {
      await this.plugin.deleteConversation(conversationId).catch(() => {});
      throw error;
    }
  }

  async forkInCurrentTab(context: ForkContext): Promise<boolean> {
    const activeTab = this.getActiveTab();
    if (!activeTab?.controllers.conversationController) return false;

    const conversationId = await this.createForkConversation(
      context,
      activeTab.executionCoordinator,
    );
    try {
      await activeTab.controllers.conversationController.switchTo(conversationId);
    } catch (error) {
      await this.plugin.deleteConversation(conversationId).catch(() => {});
      throw error;
    }
    return true;
  }

  private async createForkConversation(
    context: ForkContext,
    sourceCoordinator: TabData['executionCoordinator'],
  ): Promise<string> {
    const conversation = await this.plugin.createConversation({
      providerId: context.providerId,
      ...(context.sourceSelectedModel ? { selectedModel: context.sourceSelectedModel } : {}),
      ...(context.currentNote ? { currentNote: context.currentNote } : {}),
    });

    const title = context.sourceTitle
      ? this.buildForkTitle(context.sourceTitle, context.forkAtUserMessage)
      : undefined;

    try {
      const vaultPath = getVaultPath(this.plugin.app);
      const forkProviderState = await ProviderRegistry
        .getConversationHistoryService(conversation.providerId)
        .buildForkProviderState(
          context.sourceSessionId,
          context.resumeAt,
          context.sourceProviderState,
          vaultPath,
          {
            environment: {
              ...process.env,
              ...getRuntimeEnvironmentVariables(this.plugin.settings, conversation.providerId),
            },
            hostPlatform: process.platform,
            settings: this.plugin.settings,
            vaultPath,
          },
        );
      await this.plugin.updateConversation(conversation.id, {
        messages: context.messages,
        providerState: forkProviderState,
        ...(title && { title }),
        ...(context.currentNote && { currentNote: context.currentNote }),
      });
      await sourceCoordinator?.copyInputsForFork(conversation.id, context.resumeAt);
    } catch (error) {
      await this.plugin.deleteConversation(conversation.id).catch(() => {});
      throw error;
    }

    return conversation.id;
  }

  private buildForkTitle(sourceTitle: string, forkAtUserMessage?: number): string {
    const MAX_TITLE_LENGTH = 50;
    const forkSuffix = forkAtUserMessage ? ` (#${forkAtUserMessage})` : '';
    const forkPrefix = 'Fork: ';
    const maxSourceLength = MAX_TITLE_LENGTH - forkPrefix.length - forkSuffix.length;
    const truncatedSource = sourceTitle.length > maxSourceLength
      ? sourceTitle.slice(0, maxSourceLength - 1) + '…'
      : sourceTitle;
    let title = forkPrefix + truncatedSource + forkSuffix;

    const existingTitles = new Set(this.plugin.getConversationList().map(c => c.title));
    if (existingTitles.has(title)) {
      let n = 2;
      while (existingTitles.has(`${title} ${n}`)) n++;
      title = `${title} ${n}`;
    }

    return title;
  }

  // ============================================
  // SDK Commands (Shared)
  // ============================================

  /**
   * Gets provider-scoped SDK supported commands for a tab.
   * @returns Array of SDK commands, or empty array if no service is ready.
   */
  async getSdkCommands(tabId?: TabId): Promise<SlashCommand[]> {
    const { result } = await this.getSdkCommandDiscovery(tabId);
    return result.status === 'ready' ? [...result.items] : [];
  }

  async getProviderCommandDiscovery(
    tabId?: TabId,
    signal?: AbortSignal,
  ): Promise<ProviderCommandDiscoveryResult<ProviderCommandEntry>> {
    throwIfAborted(signal, 'Provider command discovery aborted');
    const targetTab = (tabId ? this.tabs.get(tabId) : this.getActiveTab()) ?? null;
    if (!targetTab) return { status: 'empty' };

    const providerId = getTabProviderId(targetTab, this.plugin);
    const discovery = await this.getSdkCommandDiscovery(targetTab.id, signal);
    throwIfAborted(signal, 'Provider command discovery aborted');
    const { result } = discovery;
    if (result.status === 'error' || result.status === 'requires-session') {
      return result;
    }

    const catalog = ProviderWorkspaceRegistry.getCommandCatalog(providerId);
    if (!catalog) return { status: 'empty' };
    const entries = await catalog.listDropdownEntries({
      includeBuiltIns: false,
      ...(signal ? { signal } : {}),
      allowCachedCommandSnapshot: discovery.commandSnapshot !== undefined,
      ...(discovery.commandSnapshot !== undefined
        ? { commandSnapshot: discovery.commandSnapshot }
        : {}),
    });
    return normalizeProviderCommandDiscoveryItems(entries);
  }

  private async getSdkCommandDiscovery(
    tabId?: TabId,
    signal?: AbortSignal,
  ): Promise<SdkCommandDiscovery> {
    throwIfAborted(signal, 'Provider command discovery aborted');
    const targetTab = (tabId ? this.tabs.get(tabId) : this.getActiveTab()) ?? null;
    if (!targetTab) {
      return { result: { status: 'empty' } };
    }

    const providerId = getTabProviderId(targetTab, this.plugin);
    if (!ProviderWorkspaceRegistry.getIfInitialized(providerId)) {
      await ProviderWorkspaceRegistry.ensureInitialized(this.plugin.providerHost, providerId, 'command-picker');
      throwIfAborted(signal, 'Provider command discovery aborted');
    }

    const staticCapabilities = ProviderRegistry.getCapabilities(providerId);
    if (!staticCapabilities.supportsProviderCommands) {
      return { result: { status: 'empty' } };
    }

    const catalog = ProviderWorkspaceRegistry.getCommandCatalog(providerId);
    const commandLoader = ProviderWorkspaceRegistry.getCommandLoader(providerId);
    const context = await this.buildProviderWarmupContext(targetTab, providerId);
    throwIfAborted(signal, 'Provider command discovery aborted');
    const commandContext = this.buildProviderCommandContext(targetTab, providerId, context);
    if (
      targetTab.conversationId === null
      && commandLoader
      && targetTab.id !== this.activeTabId
    ) {
      return { result: { status: 'empty' }, commandSnapshot: [] };
    }
    let result: ProviderCommandDiscoveryResult<SlashCommand> = { status: 'empty' };
    let hasCommandSnapshot = false;

    if (commandLoader) {
      hasCommandSnapshot = true;
      result = await this.ensureProviderCommandRuntime(targetTab, providerId, context, signal);
    }

    if (
      catalog
      && targetTab.id === this.activeTabId
      && this.isCommandContextCurrent(targetTab, providerId, commandContext)
      && (result.status === 'ready' || result.status === 'empty')
    ) {
      catalog.setCommandSnapshot(result.status === 'ready' ? [...result.items] : []);
    }
    return {
      result,
      ...(hasCommandSnapshot && (result.status === 'ready' || result.status === 'empty')
        ? { commandSnapshot: result.status === 'ready' ? result.items : [] }
        : {}),
    };
  }

  private async ensureProviderCommandRuntime(
    tab: TabData,
    providerId: ProviderId,
    warmupContext?: ProviderWarmupContext,
    signal?: AbortSignal,
  ): Promise<ProviderCommandDiscoveryResult<SlashCommand>> {
    throwIfAborted(signal, 'Provider command discovery aborted');
    if (!this.isProviderCommandLoaderAvailable(providerId)) {
      return { status: 'empty' };
    }

    const resolvedWarmupContext = warmupContext
      ?? await this.buildProviderWarmupContext(tab, providerId);
    const context = this.buildProviderCommandContext(
      tab,
      providerId,
      resolvedWarmupContext,
    );
    const cached = this.providerRuntimeCommandCache.get(tab.id);
    if (cached && cached.key === context.cacheKey) {
      return cached.result.status === 'ready'
        ? { status: 'ready', items: cached.result.items.map(command => ({ ...command })) as [SlashCommand, ...SlashCommand[]] }
        : cached.result;
    }

    const existing = this.providerRuntimeCommandWarmups.get(tab.id);
    if (existing?.key === context.cacheKey) {
      return await this.awaitProviderCommandWarmup(existing, signal);
    }
    this.cancelProviderRuntimeCommandWarmup(tab.id);

    const abortController = new AbortController();
    const warmup = this.warmProviderCommandRuntime(
      tab,
      providerId,
      context,
      abortController.signal,
    ).finally(() => {
      if (this.providerRuntimeCommandWarmups.get(tab.id)?.promise === warmup) {
        this.providerRuntimeCommandWarmups.delete(tab.id);
      }
    });
    const entry: ProviderCommandWarmupEntry = {
      abortController,
      key: context.cacheKey,
      promise: warmup,
    };
    this.providerRuntimeCommandWarmups.set(tab.id, entry);
    return await this.awaitProviderCommandWarmup(entry, signal);
  }

  private maybePrimeProviderExecution(tab: TabData): void {
    if (tab.state.isSwitchingConversation) return;
    void this.prewarmProviderTab(tab).catch(() => {});
  }

  private async ensureTabWorkspaceServices(
    tab: TabData,
    providerId: ProviderId,
    reason: string,
  ): Promise<boolean> {
    if (!ProviderWorkspaceRegistry.getIfInitialized(providerId)) {
      await ProviderWorkspaceRegistry.ensureInitialized(
        this.plugin.providerHost,
        providerId,
        reason,
      );
    }
    if (!this.isTabAlive(tab)) {
      return false;
    }
    refreshTabWorkspaceServices(tab, this.plugin);
    return true;
  }

  private isProviderCommandLoaderAvailable(providerId: ProviderId): boolean {
    const loader = ProviderWorkspaceRegistry.getCommandLoader(
      providerId,
    );
    if (!loader) return false;
    return loader.isAvailable(this.plugin.settings);
  }

  private async prewarmProviderTab(tab: TabData): Promise<void> {
    const providerId = tab.providerId;
    if (tab.id !== this.activeTabId) {
      return;
    }
    const context = await this.buildProviderWarmupContext(tab, providerId);

    switch (context.warmupMode) {
      case 'commands':
        await this.getSdkCommands(tab.id);
        return;
      case 'execution':
        return;
      default:
        return;
    }
  }

  private async buildProviderWarmupContext(
    tab: TabData,
    providerId: ProviderId,
  ): Promise<ProviderWarmupContext> {
    const conversation = tab.conversationId
      ? await this.plugin.getConversationById(tab.conversationId)
      : null;
    const hasConversationContext = (conversation?.messages.length ?? 0) > 0;
    const externalContextPaths = tab.ui.externalContextSelector?.getExternalContexts()
      ?? (hasConversationContext
        ? conversation?.externalContextPaths ?? []
        : this.plugin.settings.persistentExternalContextPaths ?? []);
    const baseContext: Omit<ProviderWarmupContext, 'warmupMode'> = {
      coordinatorState: tab.executionCoordinator?.state === 'disposed'
        ? 'absent'
        : tab.executionCoordinator?.state ?? 'absent',
      conversation,
      externalContextPaths,
      hasResumableNativeSeed: Boolean(
        conversation?.sessionId
        || conversation?.resumeAtMessageId
        || conversation?.providerState,
      ),
      plugin: this.plugin.providerHost,
      tab: {
        conversationId: tab.conversationId,
        draftModel: tab.draftModel,
        lifecycleState: tab.lifecycleState,
        providerId,
      },
    };
    const warmupMode = this.resolveProviderTabWarmupMode(baseContext);

    return {
      ...baseContext,
      warmupMode,
    };
  }

  private resolveProviderTabWarmupMode(
    context: Omit<ProviderWarmupContext, 'warmupMode'>,
  ): ProviderWarmupContext['warmupMode'] {
    const policy = ProviderWorkspaceRegistry.getTabWarmupPolicy(
      context.tab.providerId,
    );
    return policy?.resolveMode(context) ?? 'none';
  }

  private getProviderResourceGeneration(providerId: ProviderId): number {
    return this.providerResourceGenerations.get(providerId)
      ?? this.plugin.getAgentSkillResourceGeneration?.()
      ?? 0;
  }

  private bumpTabCommandContextRevision(tabId: TabId): void {
    this.advanceTabCommandContextRevision(tabId);
    this.providerCommandDiscoveryStores.get(tabId)?.invalidate();
  }

  private advanceTabCommandContextRevision(tabId: TabId): void {
    this.tabCommandContextRevisions.set(
      tabId,
      (this.tabCommandContextRevisions.get(tabId) ?? 0) + 1,
    );
    this.cancelProviderRuntimeCommandWarmup(tabId);
    this.providerRuntimeCommandCache.delete(tabId);
  }

  private cancelProviderRuntimeCommandWarmup(tabId: TabId): void {
    const warmup = this.providerRuntimeCommandWarmups.get(tabId);
    if (!warmup) {
      return;
    }
    warmup.abortController.abort();
    this.providerRuntimeCommandWarmups.delete(tabId);
  }

  private async awaitProviderCommandWarmup(
    warmup: ProviderCommandWarmupEntry,
    signal?: AbortSignal,
  ): Promise<ProviderCommandDiscoveryResult<SlashCommand>> {
    if (!signal) {
      return await warmup.promise;
    }
    if (signal.aborted) {
      warmup.abortController.abort();
      throwIfAborted(signal, 'Provider command discovery aborted');
    }

    let onAbort: (() => void) | null = null;
    const aborted = new Promise<never>((_resolve, reject) => {
      onAbort = () => {
        warmup.abortController.abort();
        reject(toAbortError(signal, 'Provider command discovery aborted'));
      };
      signal.addEventListener('abort', onAbort, { once: true });
    });

    try {
      return await Promise.race([warmup.promise, aborted]);
    } finally {
      if (onAbort) {
        signal.removeEventListener('abort', onAbort);
      }
    }
  }

  private isCommandContextCurrent(
    tab: TabData,
    providerId: ProviderId,
    context: ProviderCommandContext,
  ): boolean {
    return this.isTabAlive(tab)
      && getTabProviderId(tab, this.plugin) === providerId
      && (this.tabCommandContextRevisions.get(tab.id) ?? 0) === context.commandContextRevision
      && this.plugin.providerHost.executionLifecycleRegistry.getProviderGeneration(providerId)
        === context.providerGeneration
      && this.getProviderResourceGeneration(providerId) === context.resourceGeneration;
  }

  private buildProviderCommandContext(
    tab: TabData,
    providerId: ProviderId,
    warmupContext: ProviderWarmupContext,
  ): ProviderCommandContext {
    const loader = ProviderWorkspaceRegistry.getCommandLoader(
      providerId,
    );
    const fingerprint = loader?.getCacheFingerprint(this.plugin.settings) ?? 'catalog';
    const commandContextRevision = this.tabCommandContextRevisions.get(tab.id) ?? 0;
    const providerGeneration = this.plugin.providerHost.executionLifecycleRegistry
      .getProviderGeneration(providerId);
    const resourceGeneration = this.getProviderResourceGeneration(providerId);
    const allowIsolatedMetadataCreation = warmupContext.warmupMode === 'commands'
      && tab.id === this.activeTabId;

    return {
      ...warmupContext,
      cacheKey: [
        providerId,
        commandContextRevision,
        providerGeneration,
        resourceGeneration,
        fingerprint,
        allowIsolatedMetadataCreation ? 1 : 0,
      ].join('|'),
      commandContextRevision,
      providerGeneration,
      resourceGeneration,
    };
  }

  private async warmProviderCommandRuntime(
    tab: TabData,
    providerId: ProviderId,
    context: ProviderCommandContext,
    signal: AbortSignal,
  ): Promise<ProviderCommandDiscoveryResult<SlashCommand>> {
    const loader = ProviderWorkspaceRegistry.getCommandLoader(
      providerId,
    );
    if (!loader) {
      return { status: 'empty' };
    }
    const result = await loader.loadCommands({
      allowIsolatedMetadataCreation: context.warmupMode === 'commands'
        && tab.id === this.activeTabId,
      conversation: context.conversation,
      externalContextPaths: context.externalContextPaths,
      plugin: this.plugin.providerHost,
      signal,
    });

    if (
      this.isCommandContextCurrent(tab, providerId, context)
      && (result.status === 'ready' || result.status === 'empty')
    ) {
      this.providerRuntimeCommandCache.set(tab.id, {
        key: context.cacheKey,
        result: result.status === 'ready'
          ? { status: 'ready', items: result.items.map(command => ({ ...command })) as [SlashCommand, ...SlashCommand[]] }
          : result,
      });
    } else if (this.isCommandContextCurrent(tab, providerId, context)) {
      this.providerRuntimeCommandCache.delete(tab.id);
    }
    return result;
  }

  // ============================================
  // Provider Command Catalog
  // ============================================

  private ensureProviderCommandDiscoveryStore(
    tabId: TabId,
  ): ProviderCommandDiscoveryStore<ProviderCommandEntry> {
    const existing = this.providerCommandDiscoveryStores.get(tabId);
    if (existing) {
      return existing;
    }

    const discovery = new ProviderCommandDiscoveryStore(
      signal => this.getProviderCommandDiscovery(tabId, signal),
      {
        onBeforeRetry: () => this.advanceTabCommandContextRevision(tabId),
      },
    );
    this.providerCommandDiscoveryStores.set(tabId, discovery);
    return discovery;
  }

  private getProviderCatalogConfig(tab: TabData) {
    const providerId = getTabProviderId(tab, this.plugin);
    const catalog = ProviderWorkspaceRegistry.getCommandCatalog(providerId);
    if (!catalog) return null;

    return {
      config: catalog.getDropdownConfig(),
      discovery: this.ensureProviderCommandDiscoveryStore(tab.id),
    };
  }

  // ============================================
  // Cleanup
  // ============================================

  /** Destroys all tabs and cleans up resources. */
  async destroy(): Promise<void> {
    this.destroyed = true;
    await this.invalidateAndDrainConversationNavigation();
    let provisionalCleanupError: unknown;
    let didProvisionalCleanupFail = false;
    try {
      await this.provisionalCleanupPromise;
    } catch (error) {
      didProvisionalCleanupFail = true;
      provisionalCleanupError = error;
    }
    for (const discovery of this.providerCommandDiscoveryStores.values()) {
      discovery.invalidate();
    }
    for (const warmup of this.providerRuntimeCommandWarmups.values()) {
      warmup.abortController.abort();
    }

    // Each tab drains background work and persists its final state during teardown.
    await Promise.all(Array.from(this.tabs.values()).map(tab => destroyTab(tab)));

    this.tabs.clear();
    this.providerRuntimeCommandWarmups.clear();
    this.providerRuntimeCommandCache.clear();
    this.providerCommandDiscoveryStores.clear();
    this.tabCommandContextRevisions.clear();
    this.tabActivationRevisions.clear();
    this.activeTabId = null;

    if (didProvisionalCleanupFail) {
      throw provisionalCleanupError;
    }
  }
}
