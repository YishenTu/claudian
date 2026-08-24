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
  AppTabManagerState,
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
import type { ForkContext } from './TabForking';
import {
  activateTab,
  commitProvisionalTab,
  deactivateTab,
  destroyTab,
  drainTabForShutdownSnapshot,
  getTabTitle,
} from './TabLifecycle';
import {
  onProviderAvailabilityChanged,
  refreshTabWorkspaceServices,
} from './TabProviderState';
import { createTabRuntime } from './TabRuntimeFactory';
import {
  type AssembledTabRuntime,
  generateTabId,
  type TabBarItem,
  type TabId,
  type TabManagerCallbacks,
  type TabManagerInterface,
  type TabManagerViewHost,
  type TabProviderCatalogContext,
} from './types';

function isTabManagerViewHost(value: unknown): value is TabManagerViewHost {
  return !!value
    && typeof value === 'object'
    && 'getTabManager' in (value as Record<string, unknown>);
}

type CreateTabOptions = {
  activate?: boolean;
  draftModel?: string;
  lifecycleState?: Extract<AssembledTabRuntime['lifecycleState'], 'provisional' | 'cold'>;
};

type OpenConversationOptions = {
  preferNewTab?: boolean;
  activate?: boolean;
  provisional?: boolean;
};

type PendingTabSwitchRequest = {
  onActivationStarted?: (previousTabId: TabId | null) => void;
  promise: Promise<void>;
  reject: (error: unknown) => void;
  requestRevision: number;
  required: boolean;
  resolve: () => void;
  tabId: TabId;
};

type TabSwitchIntent = {
  requestRevision: number;
  tabId: TabId;
};

type ProviderRuntimeCommandCacheEntry = {
  result: ProviderCommandDiscoveryResult<SlashCommand>;
  key: string;
};

type ProviderWarmupContext = {
  commandContextRevision: number;
  coordinatorState: 'absent' | 'idle' | 'active' | 'stale';
  conversation: Conversation | null;
  externalContextPaths: string[];
  hasResumableNativeSeed: boolean;
  plugin: FeatureHost['providerHost'];
  tab: {
    conversationId: string | null;
    draftModel: string | null;
    lifecycleState: AssembledTabRuntime['lifecycleState'];
    providerId: ProviderId;
  };
  warmupMode: 'none' | 'commands' | 'execution';
};

type ProviderCommandContext = ProviderWarmupContext & {
  cacheKey: string;
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

type ForkSourceLease = {
  readonly conversationId: string | null;
  readonly tab: AssembledTabRuntime;
};

function throwCollectedErrors(errors: readonly unknown[], message: string): void {
  if (errors.length === 0) return;
  if (errors.length === 1) throw errors[0];
  throw new AggregateError(errors, message);
}

/**
 * TabManager coordinates multiple chat tabs.
 */
export class TabManager implements TabManagerInterface {
  private plugin: FeatureHost;
  private containerEl: HTMLElement;
  private view: TabManagerViewHost;

  private tabs: Map<TabId, AssembledTabRuntime> = new Map();
  private activeTabId: TabId | null = null;
  private readonly committedTabIds = new Set<TabId>();
  private committedActiveTabId: TabId | null = null;
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
  private assemblingTabIds = new Set<TabId>();
  private closingTabIds = new Set<TabId>();
  private inFlightCloseOperations = new Set<Promise<boolean>>();

  /** Guard to prevent concurrent tab switches. */
  private isSwitchingTab = false;
  private pendingSwitchRequests: PendingTabSwitchRequest[] = [];
  private readonly tabSwitchIdleWaiters = new Set<() => void>();
  private tabSwitchRequestRevision = 0;
  private latestTabSwitchIntent: TabSwitchIntent | null = null;
  private conversationNavigationRequestRevision = 0;
  private conversationNavigationTail: Promise<void> = Promise.resolve();
  private liveTabReplacementPromise: Promise<AssembledTabRuntime | null> | null = null;
  private provisionalCleanupPromise: Promise<void> | null = null;
  private profiledFirstHydration = false;
  private destructionPromise: Promise<void> | null = null;
  private shutdownDrainPromise: Promise<void> | null = null;
  private destroyed = false;
  private shutdownSnapshotOpen = false;

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
  ): Promise<AssembledTabRuntime | null> {
    if (this.destroyed) return null;

    const runtimeTabId = tabId ?? generateTabId();
    if (this.tabs.has(runtimeTabId) || this.assemblingTabIds.has(runtimeTabId)) {
      throw new Error(`Tab ID is already owned or reserved: ${runtimeTabId}`);
    }

    this.assemblingTabIds.add(runtimeTabId);
    const activationRequestRevision = options.activate !== false
      ? this.reserveTabSwitchIntent(runtimeTabId)
      : null;
    try {
      return await this.createReservedTab(
        conversationId,
        runtimeTabId,
        options,
        activationRequestRevision,
      );
    } finally {
      this.assemblingTabIds.delete(runtimeTabId);
    }
  }

  private async createReservedTab(
    conversationId: string | null | undefined,
    runtimeTabId: TabId,
    options: CreateTabOptions,
    activationRequestRevision: number | null,
  ): Promise<AssembledTabRuntime | null> {
    if (this.destroyed) return null;

    const {
      activate = true,
      draftModel,
      lifecycleState = 'cold',
    } = options;

    const conversation = conversationId
      ? this.plugin.getCachedConversation(conversationId)
      : undefined;

    let tab: AssembledTabRuntime | null = null;
    try {
      tab = await createTabRuntime({
        plugin: this.plugin,
        containerEl: this.containerEl,
        component: this.view,
        conversation: conversation ?? undefined,
        tabId: runtimeTabId,
        ...(typeof draftModel === 'string' ? { draftModel } : {}),
        lifecycleState,
        getProviderCatalogConfig: runtime => this.getProviderCatalogConfig(runtime),
        isRuntimeLive: runtime => this.isTabAlive(runtime),
        forkRequestCallback: (forkContext) => {
          const sourceTab = tab;
          if (!sourceTab || !this.isTabAlive(sourceTab)) return Promise.resolve();
          return this.handleForkRequest(sourceTab, forkContext);
        },
        openConversation: (id) => {
          const sourceTab = tab;
          if (!sourceTab || !this.isTabAlive(sourceTab)) return Promise.resolve();
          return this.openConversationFromRuntime(sourceTab, id);
        },
        onStreamingChanged: (runtime, isStreaming) => {
          if (!this.isTabStateMutable(runtime)) return;
          this.callbacks.onTabStreamingChanged?.(runtime.id, isStreaming);
          if (!isStreaming) runtime.session.executionCoordinator.notifyMayCool();
        },
        onWorkChanged: runtime => {
          if (!this.isTabStateMutable(runtime)) return;
          this.callbacks.onTabWorkChanged?.(runtime.id);
        },
        onRewindingChanged: (runtime, isRewinding) => {
          if (!this.isTabStateMutable(runtime)) return;
          this.callbacks.onTabRewindingChanged?.(runtime.id, isRewinding);
          if (!isRewinding) runtime.session.executionCoordinator.notifyMayCool();
        },
        onAttentionChanged: (runtime, attention) => {
          if (!this.isTabStateMutable(runtime)) return;
          this.callbacks.onTabAttentionChanged?.(runtime.id, attention);
          if (attention?.kind !== 'action-required') {
            runtime.session.executionCoordinator.notifyMayCool();
          }
        },
        captureReviewableSettlement: (runtime, outcome) => {
          const shouldReport = this.isTabStateMutable(runtime) && this.activeTabId !== runtime.id;
          const activationRevision = this.tabActivationRevisions.get(runtime.id) ?? 0;
          return () => {
            if (
              shouldReport
              && this.isTabStateMutable(runtime)
              && (this.tabActivationRevisions.get(runtime.id) ?? 0) === activationRevision
            ) {
              runtime.state.markReviewRequired(outcome);
            }
          };
        },
        onConversationIdChanged: (runtime, nextConversationId) => {
          if (!this.isTabOwned(runtime)) return;
          if (this.destroyed && !this.shutdownSnapshotOpen) return;
          runtime.conversationId = nextConversationId;
          if (!this.destroyed) {
            this.bumpTabCommandContextRevision(runtime.id);
          }
          this.callbacks.onTabConversationChanged?.(runtime.id, nextConversationId);
        },
        onDraftModelChanged: (runtime, draftModel) => {
          if (!this.isTabStateMutable(runtime)) return;
          this.callbacks.onTabDraftChanged?.(runtime.id, draftModel);
        },
        onCommandContextChanged: runtime => {
          this.bumpTabCommandContextRevision(runtime.id);
        },
        onProviderChanged: async (runtime, providerId) => {
          if (!this.isTabAlive(runtime)) return;
          this.bumpTabCommandContextRevision(runtime.id);
          if (!await this.ensureTabWorkspaceServices(
            runtime,
            providerId,
            'provider-selection',
          )) return;
          this.callbacks.onTabProviderChanged?.(runtime.id, providerId);
        },
      });

      if (tab.id !== runtimeTabId) {
        throw new Error(
          `Tab runtime ID ${tab.id} does not match reserved ID ${runtimeTabId}`,
        );
      }

      if (this.destroyed) {
        const abandonedTab = tab;
        tab = null;
        const rollbackErrors: unknown[] = [];
        try {
          await destroyTab(abandonedTab);
        } catch (rollbackError) {
          rollbackErrors.push(rollbackError);
        }
        rollbackErrors.push(...this.releaseTabRuntimeMetadata(runtimeTabId));
        throwCollectedErrors(
          rollbackErrors,
          'Failed to roll back a tab assembled after manager destruction',
        );
        return null;
      }

      this.tabCommandContextRevisions.set(tab.id, 0);
      this.tabActivationRevisions.set(tab.id, 0);
      this.ensureProviderCommandDiscoveryStore(tab.id);
    } catch (error) {
      const rollbackErrors: unknown[] = [];
      if (tab) {
        try {
          await destroyTab(tab);
        } catch (rollbackError) {
          rollbackErrors.push(rollbackError);
        }
      }
      rollbackErrors.push(...this.releaseTabRuntimeMetadata(runtimeTabId));
      if (rollbackErrors.length > 0) {
        throw new AggregateError(
          [error, ...rollbackErrors],
          'Tab runtime setup failed and rollback also encountered errors',
          { cause: error },
        );
      }
      throw error;
    }

    let rollbackActiveTabId = this.activeTabId;
    this.tabs.set(tab.id, tab);
    try {
      if (activate) {
        await this.requestTabSwitch(
          tab.id,
          true,
          activationRequestRevision ?? this.reserveTabSwitchIntent(tab.id),
          previousTabId => {
            rollbackActiveTabId = previousTabId;
          },
        );
      }

      if (!this.isTabAlive(tab)) return null;
    } catch (error) {
      const rollbackErrors = await this.rollbackAdmittedTab(tab, rollbackActiveTabId);
      if (rollbackErrors.length > 0) {
        throw new AggregateError(
          [error, ...rollbackErrors],
          'Tab admission failed and rollback also encountered errors',
          { cause: error },
        );
      }
      throw error;
    }

    this.committedTabIds.add(tab.id);
    if (this.activeTabId === tab.id) this.committedActiveTabId = tab.id;

    try {
      this.callbacks.onTabCreated?.(tab);
    } catch {
      // Admission is committed; an observer failure must not retract published membership.
    }
    return tab;
  }

  private async rollbackAdmittedTab(
    tab: AssembledTabRuntime,
    previousActiveTabId: TabId | null,
  ): Promise<unknown[]> {
    const rollbackErrors: unknown[] = [];
    if (this.tabs.get(tab.id) !== tab) {
      rollbackErrors.push(...this.releaseTabRuntimeMetadata(tab.id));
      return rollbackErrors;
    }

    tab.lifecycleState = 'closing';
    rollbackErrors.push(...this.releaseTabRuntimeMetadata(tab.id));

    if (this.activeTabId === tab.id) {
      try {
        deactivateTab(tab);
      } catch (error) {
        rollbackErrors.push(error);
      }
      this.activeTabId = null;

      const previousTab = previousActiveTabId
        ? this.tabs.get(previousActiveTabId) ?? null
        : null;
      if (!this.destroyed && previousTab && previousTab.lifecycleState !== 'closing') {
        try {
          this.activeTabId = previousTab.id;
          this.tabActivationRevisions.set(
            previousTab.id,
            (this.tabActivationRevisions.get(previousTab.id) ?? 0) + 1,
          );
          activateTab(previousTab);
          previousTab.state.acknowledgeReview();
        } catch (error) {
          this.activeTabId = null;
          rollbackErrors.push(error);
        }
      }
    }

    this.tabs.delete(tab.id);
    try {
      await destroyTab(tab);
    } catch (error) {
      rollbackErrors.push(error);
    }
    rollbackErrors.push(...this.releaseTabRuntimeMetadata(tab.id));

    return rollbackErrors;
  }

  /**
   * Switches to a different tab.
   * @param tabId The tab to switch to.
   */
  async switchToTab(tabId: TabId): Promise<void> {
    const tab = this.tabs.get(tabId);
    if (!tab || !this.isTabAlive(tab)) return;
    const previousTabId = this.activeTabId;
    await this.requestTabSwitch(tabId, false, this.reserveTabSwitchIntent(tabId));
    if (this.activeTabId !== tabId || previousTabId === tabId) return;

    try {
      this.callbacks.onActiveTabCommitted?.(previousTabId, tabId);
    } catch {
      // Selection is committed; an observer failure must not roll it back.
    }
  }

  private reserveTabSwitchIntent(tabId: TabId): number {
    const requestRevision = ++this.tabSwitchRequestRevision;
    this.latestTabSwitchIntent = { requestRevision, tabId };
    return requestRevision;
  }

  private async requestTabSwitch(
    tabId: TabId,
    required: boolean,
    requestRevision: number,
    onActivationStarted?: (previousTabId: TabId | null) => void,
  ): Promise<void> {
    const tab = this.tabs.get(tabId);
    if (!tab || !this.isTabAlive(tab)) {
      return;
    }

    // Guard against concurrent tab switches
    if (this.isSwitchingTab) {
      return this.queuePendingTabSwitch(
        tabId,
        required,
        requestRevision,
        onActivationStarted,
      );
    }

    this.isSwitchingTab = true;
    const previousTabId = this.activeTabId;
    let activeTabChangePublicationStarted = false;
    let switchRolledBack = false;
    onActivationStarted?.(previousTabId);

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
      if (this.callbacks.onActiveTabChanged) {
        activeTabChangePublicationStarted = true;
        this.callbacks.onActiveTabChanged(previousTabId, tabId);
      }

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
            await tab.controllers.conversationController.switchTo(tab.conversationId);
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
          tab.controllers.conversationController.initializeWelcome();
          tab.hydrationState = 'ready';
        }
      } catch (error) {
        if (!this.isTabAlive(tab)) return;
        tab.hydrationState = 'failed';
        this.renderTabHydrationState(tab, error);
        return;
      }

      if (!this.isTabAlive(tab)) return;
      try {
        this.callbacks.onTabSwitched?.(previousTabId, tabId);
      } catch {
        // Selection is committed; a completion observer cannot roll it back.
      }
    } catch (error) {
      switchRolledBack = true;
      const rollbackErrors = this.restorePreviousTabAfterFailedSwitch(
        tab,
        previousTabId,
        activeTabChangePublicationStarted,
      );
      if (rollbackErrors.length > 0) {
        throw new AggregateError(
          [error, ...rollbackErrors],
          `Failed to switch to tab ${tabId} and restore the previous tab`,
          { cause: error },
        );
      }
      throw error;
    } finally {
      if (
        !switchRolledBack
        && this.activeTabId === tabId
        && this.committedTabIds.has(tabId)
        && this.isTabAlive(tab)
      ) {
        this.committedActiveTabId = tabId;
      }
      this.isSwitchingTab = false;
      this.queueLatestTabSwitchIntent(requestRevision);
      this.startPendingTabSwitch();
    }
  }

  private queuePendingTabSwitch(
    tabId: TabId,
    required: boolean,
    requestRevision: number,
    onActivationStarted?: (previousTabId: TabId | null) => void,
  ): Promise<void> {
    const existingRequest = this.pendingSwitchRequests.find(request => (
      request.requestRevision === requestRevision
      && request.tabId === tabId
      && request.required === required
    ));
    if (existingRequest) return existingRequest.promise;

    if (!required) {
      const newerPendingRequest = this.pendingSwitchRequests.find(request => (
        !request.required && request.requestRevision > requestRevision
      ));
      if (newerPendingRequest) return Promise.resolve();

      const retainedRequests: PendingTabSwitchRequest[] = [];
      for (const pendingRequest of this.pendingSwitchRequests) {
        if (pendingRequest.required || pendingRequest.requestRevision > requestRevision) {
          retainedRequests.push(pendingRequest);
        } else {
          pendingRequest.resolve();
        }
      }
      this.pendingSwitchRequests = retainedRequests;
    }

    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<void>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    this.pendingSwitchRequests.push({
      onActivationStarted,
      promise,
      reject,
      requestRevision,
      required,
      resolve,
      tabId,
    });
    this.pendingSwitchRequests.sort((left, right) => (
      left.requestRevision - right.requestRevision
    ));
    return promise;
  }

  private restorePreviousTabAfterFailedSwitch(
    failedTab: AssembledTabRuntime,
    previousTabId: TabId | null,
    republishPreviousTab: boolean,
  ): unknown[] {
    const rollbackErrors: unknown[] = [];
    const activeTabId = this.activeTabId;
    const failedTabWasActive = activeTabId === failedTab.id;
    const previousTabWasActive = activeTabId === previousTabId;

    if (failedTabWasActive) {
      try {
        deactivateTab(failedTab);
      } catch (error) {
        rollbackErrors.push(error);
      }
      this.activeTabId = null;
    }

    const previousTab = previousTabId
      ? this.tabs.get(previousTabId) ?? null
      : null;
    if (
      !this.destroyed
      && previousTab
      && this.isTabOwned(previousTab)
      && (failedTabWasActive || previousTabWasActive)
    ) {
      this.activeTabId = previousTab.id;
      this.tabActivationRevisions.set(
        previousTab.id,
        (this.tabActivationRevisions.get(previousTab.id) ?? 0) + 1,
      );
      let previousTabRestored = false;
      try {
        activateTab(previousTab);
        previousTab.state.acknowledgeReview();
        previousTabRestored = true;
      } catch (error) {
        this.activeTabId = null;
        rollbackErrors.push(error);
      }
      if (previousTabRestored && republishPreviousTab) {
        try {
          this.callbacks.onActiveTabChanged?.(failedTab.id, previousTab.id);
        } catch (error) {
          rollbackErrors.push(error);
        }
      }
    }

    return rollbackErrors;
  }

  private queueLatestTabSwitchIntent(completedRequestRevision: number): void {
    const latestIntent = this.latestTabSwitchIntent;
    if (
      this.destroyed
      || !latestIntent
      || latestIntent.requestRevision <= completedRequestRevision
      || latestIntent.tabId === this.activeTabId
    ) {
      return;
    }

    const target = this.tabs.get(latestIntent.tabId);
    if (!target || !this.isTabAlive(target)) return;
    if (this.pendingSwitchRequests.some(request => (
      request.requestRevision === latestIntent.requestRevision
      && request.tabId === latestIntent.tabId
    ))) {
      return;
    }
    void this.queuePendingTabSwitch(
      latestIntent.tabId,
      false,
      latestIntent.requestRevision,
    ).catch(() => undefined);
  }

  private startPendingTabSwitch(): void {
    const pendingRequest = this.pendingSwitchRequests.shift() ?? null;
    if (!pendingRequest) {
      this.resolveTabSwitchIdleWaitersIfIdle();
      return;
    }
    if (pendingRequest.tabId === this.activeTabId) {
      pendingRequest.resolve();
      this.startPendingTabSwitch();
      return;
    }

    void this.requestTabSwitch(
      pendingRequest.tabId,
      pendingRequest.required,
      pendingRequest.requestRevision,
      pendingRequest.onActivationStarted,
    ).then(
      () => {
        pendingRequest.resolve();
        if (!this.isSwitchingTab && this.pendingSwitchRequests.length > 0) {
          this.startPendingTabSwitch();
        } else {
          this.resolveTabSwitchIdleWaitersIfIdle();
        }
      },
      (error) => {
        pendingRequest.reject(error);
        if (!this.isSwitchingTab && this.pendingSwitchRequests.length > 0) {
          this.startPendingTabSwitch();
        } else {
          this.resolveTabSwitchIdleWaitersIfIdle();
        }
      },
    );
  }

  getTabSwitchRequestRevision(): number {
    return this.tabSwitchRequestRevision;
  }

  async waitForTabSwitchIdle(): Promise<void> {
    while (this.isSwitchingTab || this.pendingSwitchRequests.length > 0) {
      await new Promise<void>((resolve) => {
        this.tabSwitchIdleWaiters.add(resolve);
      });
    }
  }

  private resolveTabSwitchIdleWaitersIfIdle(): void {
    if (this.isSwitchingTab || this.pendingSwitchRequests.length > 0) return;

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
    return this.trackCloseOperation(this.closeTabWithPolicy(tabId, force, true));
  }

  /**
   * Discards a manager-owned tab even when it is the last blank draft.
   * A fresh draft is installed when needed to preserve the live-manager invariant.
   */
  async discardTab(tabId: TabId): Promise<boolean> {
    return this.trackCloseOperation(this.closeTabWithPolicy(tabId, true, false));
  }

  private trackCloseOperation(operation: Promise<boolean>): Promise<boolean> {
    const trackedOperation = operation.finally(() => {
      this.inFlightCloseOperations.delete(trackedOperation);
    });
    this.inFlightCloseOperations.add(trackedOperation);
    return trackedOperation;
  }

  private async closeTabWithPolicy(
    tabId: TabId,
    force: boolean,
    preserveLastBlank: boolean,
  ): Promise<boolean> {
    const tab = this.tabs.get(tabId);
    if (!tab) {
      return false;
    }
    if (tab.lifecycleState === 'closing' || this.closingTabIds.has(tabId)) {
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
    if (
      preserveLastBlank
      && this.tabs.size === 1
      && !tab.conversationId
      && tab.state.messages.length === 0
    ) {
      return false;
    }

    // Reserve the close before fallible replacement assembly without fencing state callbacks.
    this.closingTabIds.add(tabId);
    tab.session.pauseIntentAdmission();
    try {
      const tabIdsBefore = Array.from(this.tabs.keys());
      const closingIndex = tabIdsBefore.indexOf(tabId);
      let successor = this.findLiveTabAfterClose(tabIdsBefore, closingIndex);
      if (!successor) {
        successor = await this.ensureLiveTabReplacement();
      }
      if (!successor || this.tabs.get(tabId) !== tab) {
        return false;
      }

      // Keep the active source reversible until successor activation and publication commit.
      if (this.activeTabId === tabId) {
        await this.switchToTab(successor.id);
        const activeTab = this.getActiveTab();
        if (
          !activeTab
          || activeTab === tab
          || !this.isTabAvailableToAdmittedClose(activeTab)
        ) {
          return false;
        }
      }

      // Replacement admission is complete; teardown is now irreversible.
      tab.lifecycleState = 'closing';
      this.committedTabIds.delete(tabId);
      if (this.committedActiveTabId === tabId) {
        this.committedActiveTabId = null;
      }

      const closeErrors: unknown[] = [];

      // Prevent in-flight hydration from mutating this tab while close awaits persistence.
      closeErrors.push(...this.releaseTabRuntimeMetadata(tabId));

      // Save conversation before closing. Cleanup remains mandatory if save fails.
      try {
        await tab.controllers.conversationController.save();
      } catch (error) {
        closeErrors.push(error);
      }

      // Destroy tab resources, then release manager ownership even if teardown fails.
      try {
        await destroyTab(tab);
      } catch (error) {
        closeErrors.push(error);
      }
      closeErrors.push(...this.releaseTabRuntimeMetadata(tabId));
      this.tabs.delete(tabId);
      const wasActiveTab = this.activeTabId === tabId;
      if (wasActiveTab) {
        this.activeTabId = null;
      }
      if (!this.destroyed) {
        try {
          this.callbacks.onTabClosed?.(tabId);
        } catch (error) {
          closeErrors.push(error);
        }
      }

      // Reconcile after every close because a different active tab may be closing concurrently.
      if (!this.destroyed) {
        try {
          await this.reconcileLiveTabAfterClose(tabIdsBefore, closingIndex);
        } catch (error) {
          closeErrors.push(error);
        }
      }

      throwCollectedErrors(closeErrors, `Failed to close tab ${tabId} cleanly`);
      return true;
    } finally {
      this.closingTabIds.delete(tabId);
      tab.session.resumeIntentAdmission();
      if (this.isTabStateMutable(tab) && tab.session.acceptsIntents) {
        tab.controllers.inputController.resumeQueuedTurnAfterIntentAdmission();
      }
    }
  }

  private async reconcileLiveTabAfterClose(
    tabIdsBefore: readonly TabId[],
    closingIndex: number,
  ): Promise<void> {
    if (this.destroyed) return;

    const activeTab = this.getActiveTab();
    if (activeTab && this.isTabAvailableAfterCloseClaims(activeTab)) return;

    const replacement = await this.resolveLiveTabAfterClose(tabIdsBefore, closingIndex);
    if (!replacement || !this.isTabAvailableAfterCloseClaims(replacement)) return;
    if (this.activeTabId !== replacement.id) {
      await this.switchToTab(replacement.id);
    }
  }

  private async resolveLiveTabAfterClose(
    tabIdsBefore: readonly TabId[],
    closingIndex: number,
  ): Promise<AssembledTabRuntime | null> {
    if (this.destroyed) return null;

    let replacement = this.findLiveTabAfterClose(tabIdsBefore, closingIndex);
    if (!replacement) {
      try {
        replacement = await this.ensureLiveTabReplacement();
      } catch (error) {
        replacement = this.findLiveTabAfterClose(tabIdsBefore, closingIndex);
        if (!replacement) throw error;
      }
    }
    return replacement && this.isTabAvailableAfterCloseClaims(replacement)
      ? replacement
      : null;
  }

  private findLiveTabAfterClose(
    tabIdsBefore: readonly TabId[],
    closingIndex: number,
  ): AssembledTabRuntime | null {
    if (this.destroyed) return null;

    const before = tabIdsBefore.slice(0, Math.max(0, closingIndex)).reverse();
    const after = tabIdsBefore.slice(Math.max(0, closingIndex + 1));
    const preferredIds = closingIndex === 0
      ? [...after, ...before]
      : [...before, ...after];
    const candidateIds = new Set<TabId>([
      ...preferredIds,
      ...this.tabs.keys(),
    ]);
    return Array.from(candidateIds)
      .map(id => this.tabs.get(id) ?? null)
      .find((candidate): candidate is AssembledTabRuntime => (
        !!candidate && this.isTabAvailableAfterCloseClaims(candidate)
      )) ?? null;
  }

  private async ensureLiveTabReplacement(): Promise<AssembledTabRuntime | null> {
    if (this.destroyed) return null;

    const existing = Array.from(this.tabs.values())
      .find(tab => this.isTabAvailableAfterCloseClaims(tab));
    if (existing) return existing;
    if (this.liveTabReplacementPromise) return this.liveTabReplacementPromise;

    const replacement = this.createTab(null, undefined, { activate: false });
    this.liveTabReplacementPromise = replacement;
    try {
      return await replacement;
    } finally {
      if (this.liveTabReplacementPromise === replacement) {
        this.liveTabReplacementPromise = null;
      }
    }
  }

  private isTabAlive(tab: AssembledTabRuntime): boolean {
    return !this.destroyed
      && !this.closingTabIds.has(tab.id)
      && this.isTabOwned(tab);
  }

  private isTabStateMutable(tab: AssembledTabRuntime): boolean {
    return !this.destroyed && this.isTabOwned(tab);
  }

  private isTabAvailableAfterCloseClaims(tab: AssembledTabRuntime): boolean {
    return !this.destroyed && this.isTabAvailableToAdmittedClose(tab);
  }

  private isTabAvailableToAdmittedClose(tab: AssembledTabRuntime): boolean {
    return !this.closingTabIds.has(tab.id) && this.isTabOwned(tab);
  }

  private isTabOwned(tab: AssembledTabRuntime): boolean {
    return tab.lifecycleState !== 'closing'
      && this.tabs.get(tab.id) === tab;
  }

  private waitForTabPaint(tab: AssembledTabRuntime): Promise<void> {
    return new Promise(resolve => {
      scheduleAnimationFrame(resolve, tab.dom.contentEl.ownerDocument?.defaultView ?? null);
    });
  }

  private renderTabHydrationState(tab: AssembledTabRuntime, error?: unknown): void {
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
  getActiveTab(): AssembledTabRuntime | null {
    return this.activeTabId ? this.tabs.get(this.activeTabId) ?? null : null;
  }

  /** Gets the active tab ID. */
  getActiveTabId(): TabId | null {
    return this.activeTabId;
  }

  /** Gets a tab by ID. */
  getTab(tabId: TabId): AssembledTabRuntime | null {
    return this.tabs.get(tabId) ?? null;
  }

  /** Gets all tabs. */
  getAllTabs(): AssembledTabRuntime[] {
    return Array.from(this.tabs.values());
  }

  /** True while the tab has any user-visible foreground or background work in progress. */
  isTabWorking(tabId: TabId): boolean {
    const tab = this.tabs.get(tabId);
    if (!tab) return false;
    return tab.state.isStreaming
      || tab.session.activeTurn !== null
      || tab.executionCoordinator.hasBackgroundWork
      || tab.services.subagentManager.hasActiveAsyncSubagents();
  }

  /** Reconciles blank drafts after provider/model availability changes. */
  reconcileProviderAvailability(): void {
    for (const tab of this.tabs.values()) {
      if (tab.lifecycleState === 'closing') continue;
      if (onProviderAvailabilityChanged(tab, this.plugin)) {
        this.callbacks.onTabDraftChanged?.(tab.id, tab.draftModel);
        this.callbacks.onTabProviderChanged?.(tab.id, tab.providerId);
      }
    }
  }

  /** Gets the number of tabs. */
  getTabCount(): number {
    return this.tabs.size;
  }

  /** Captures every open tab shell without persisting runtime lifecycle state. */
  getPersistedState(): AppTabManagerState {
    const openTabs: AppTabManagerState['openTabs'] = [];
    const openTabIds = new Set<TabId>();

    for (const tab of this.tabs.values()) {
      if (!this.committedTabIds.has(tab.id)) continue;
      openTabs.push({
        tabId: tab.id,
        conversationId: tab.conversationId,
        ...(tab.conversationId === null && tab.draftModel
          ? { draftModel: tab.draftModel }
          : {}),
      });
      openTabIds.add(tab.id);
    }

    const activeTabId = this.committedActiveTabId
      && openTabIds.has(this.committedActiveTabId)
      ? this.committedActiveTabId
      : null;

    return { openTabs, activeTabId };
  }

  /** Restores open shells cold, then activates exactly one final target. */
  async restoreState(state: AppTabManagerState): Promise<void> {
    for (const tabState of state.openTabs) {
      if (
        tabState.conversationId
        && !this.plugin.getCachedConversation(tabState.conversationId)
      ) {
        continue;
      }
      try {
        await this.createTab(tabState.conversationId, tabState.tabId, {
          activate: false,
          lifecycleState: 'cold',
          ...(typeof tabState.draftModel === 'string'
            ? { draftModel: tabState.draftModel }
            : {}),
        });
      } catch {
        // A malformed or unavailable shell must not prevent the remaining restore.
      }
    }

    const targetTabId = state.activeTabId && this.tabs.has(state.activeTabId)
      ? state.activeTabId
      : this.tabs.keys().next().value ?? null;
    if (targetTabId) {
      await this.switchToTab(targetTabId);
      return;
    }

    await this.createTab();
  }

  /** Checks if more tabs can be created. */
  canCreateTab(): boolean {
    return !this.destroyed;
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
        commitProvisionalTab(activeTab);
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
        isWorking: this.isTabWorking(tab.id),
        attention: tab.state.attention,
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
      null,
    );
  }

  private async openConversationFromRuntime(
    sourceTab: AssembledTabRuntime,
    conversationId: string,
  ): Promise<void> {
    await this.enqueueConversationNavigation(
      conversationId,
      false,
      true,
      false,
      sourceTab,
    );
  }

  private async enqueueConversationNavigation(
    conversationId: string,
    preferNewTab: boolean,
    activate: boolean,
    provisional: boolean,
    sourceTab: AssembledTabRuntime | null,
  ): Promise<void> {
    if (
      this.destroyed
      || this.provisionalCleanupPromise
      || (sourceTab && !this.isTabAlive(sourceTab))
    ) return;
    const requestRevision = ++this.conversationNavigationRequestRevision;
    const pending = this.conversationNavigationTail
      .catch(() => undefined)
      .then(async () => {
        if (
          this.destroyed
          || requestRevision !== this.conversationNavigationRequestRevision
          || (sourceTab && !this.isTabAlive(sourceTab))
        ) return;
        await this.openConversationImmediately(
          conversationId,
          preferNewTab,
          activate,
          provisional,
          sourceTab,
          requestRevision,
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

  private isConversationNavigationCurrent(
    requestRevision: number,
    sourceTab: AssembledTabRuntime | null,
  ): boolean {
    return !this.destroyed
      && requestRevision === this.conversationNavigationRequestRevision
      && (!sourceTab || this.isTabAlive(sourceTab));
  }

  private async openConversationImmediately(
    conversationId: string,
    preferNewTab: boolean,
    activate: boolean,
    provisional: boolean,
    sourceTab: AssembledTabRuntime | null,
    requestRevision: number,
  ): Promise<void> {
    if (!this.isConversationNavigationCurrent(requestRevision, sourceTab)) return;

    // Check if conversation is already open in this view's tabs.
    const localTarget = Array.from(this.tabs.values())
      .find(tab => this.isTabAlive(tab) && tab.conversationId === conversationId);
    if (localTarget) {
      await this.switchToTab(localTarget.id);
      if (!this.isConversationNavigationCurrent(requestRevision, sourceTab)) return;
      if (this.isTabAlive(localTarget) && localTarget.conversationId === conversationId) {
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
      if (!this.isConversationNavigationCurrent(requestRevision, sourceTab)) return;
      const refreshedTarget = this.plugin.findConversationAcrossViews(conversationId);
      const targetManager = refreshedTarget?.view.getTabManager() ?? null;
      const targetTab = targetManager?.getTab(refreshedTarget?.tabId ?? '') ?? null;
      if (
        refreshedTarget?.view === crossViewResult.view
        && refreshedTarget.tabId === crossViewResult.tabId
        && targetManager?.canCreateTab()
        && targetTab?.lifecycleState !== 'closing'
        && targetTab?.conversationId === conversationId
      ) {
        await targetManager.switchToTab(refreshedTarget.tabId);
        if (!this.isConversationNavigationCurrent(requestRevision, sourceTab)) return;
        const completedTarget = targetManager.getTab(refreshedTarget.tabId);
        if (
          completedTarget === targetTab
          && targetManager.canCreateTab()
          && completedTarget.lifecycleState !== 'closing'
          && completedTarget.conversationId === conversationId
        ) {
          return;
        }
      }
    }

    // Open in current tab or new tab
    if (preferNewTab) {
      if (provisional) {
        const previewTab = Array.from(this.tabs.values())
          .find(tab => this.isTabAlive(tab) && tab.lifecycleState === 'provisional');
        if (previewTab) {
          await previewTab.controllers.conversationController.switchTo(conversationId);
          if (!this.isConversationNavigationCurrent(requestRevision, sourceTab)) return;
          if (
            this.isTabAlive(previewTab)
            && previewTab.conversationId === conversationId
          ) {
            if (activate) {
              await this.switchToTab(previewTab.id);
            }
            if (
              this.isConversationNavigationCurrent(requestRevision, sourceTab)
              && this.isTabAlive(previewTab)
              && previewTab.conversationId === conversationId
            ) {
              return;
            }
          }
        }
      }
      const createdTab = await this.createTab(conversationId, undefined, {
        activate,
        lifecycleState: provisional ? 'provisional' : 'cold',
      });
      if (!this.isConversationNavigationCurrent(requestRevision, sourceTab)) {
        if (
          createdTab
          && this.tabs.get(createdTab.id) === createdTab
          && createdTab.conversationId === conversationId
          && createdTab.session.userOwnershipRevision === 0
        ) {
          await this.discardTab(createdTab.id);
        }
        return;
      }
      if (createdTab && this.isTabAlive(createdTab)) {
        if (
          this.isConversationNavigationCurrent(requestRevision, sourceTab)
          && this.isTabAlive(createdTab)
          && createdTab.conversationId === conversationId
        ) {
          return;
        }
      }
    }

    // Fall back to a live local owner when an awaited target disappears.
    // Don't set tab.conversationId here: the controller callback commits it only
    // after a successful switch.
    const preferredTab = sourceTab ?? this.getActiveTab();
    const activeTab = preferredTab && this.isTabAlive(preferredTab)
      ? preferredTab
      : Array.from(this.tabs.values()).find(tab => this.isTabAlive(tab)) ?? null;
    if (activeTab) {
      await activeTab.controllers.conversationController.switchTo(conversationId);
      if (
        this.isConversationNavigationCurrent(requestRevision, sourceTab)
        && this.isTabAlive(activeTab)
        && activeTab.conversationId === conversationId
      ) {
        commitProvisionalTab(activeTab);
        if (this.activeTabId !== activeTab.id) {
          await this.switchToTab(activeTab.id);
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
      await activeTab.controllers.conversationController.createNew();
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
    resolve: (tab: AssembledTabRuntime) => ProviderId,
  ): Iterable<AssembledTabRuntime> {
    const filter = providerIds
      ? new Set(Array.isArray(providerIds) ? providerIds : [providerIds])
      : null;

    for (const tab of this.tabs.values()) {
      if (!this.isTabAlive(tab)) {
        continue;
      }
      if (filter && !filter.has(resolve(tab))) {
        continue;
      }
      yield tab;
    }
  }

  // ============================================
  // Fork
  // ============================================

  private async handleForkRequest(
    sourceTab: AssembledTabRuntime,
    context: ForkContext,
  ): Promise<void> {
    const sourceLease: ForkSourceLease = {
      conversationId: context.sourceConversationId,
      tab: sourceTab,
    };
    if (!this.isForkSourceCurrent(sourceLease)) return;

    const shouldForkToNewTab = this.callbacks.shouldForkToNewTab?.() ?? false;
    const target = shouldForkToNewTab
      ? 'new-tab'
      : await chooseForkTarget(this.plugin.app);
    if (!target || !this.isForkSourceCurrent(sourceLease)) return;

    if (target === 'new-tab') {
      const tab = await this.forkToNewTab(context, sourceTab);
      if (!tab) return;
      if (!shouldForkToNewTab) {
        new Notice(t('chat.fork.notice'));
      }
    } else {
      const success = await this.forkInCurrentTab(context, sourceTab);
      if (!success) {
        new Notice(t('chat.fork.failed', { error: t('chat.fork.errorNoActiveTab') }));
        return;
      }
      new Notice(t('chat.fork.noticeCurrentTab'));
    }
  }

  async forkToNewTab(
    context: ForkContext,
    sourceTab: AssembledTabRuntime | null = this.getActiveTab(),
  ): Promise<AssembledTabRuntime | null> {
    const sourceLease = sourceTab
      ? { conversationId: context.sourceConversationId, tab: sourceTab }
      : null;
    if (!this.isForkSourceCurrent(sourceLease)) return null;
    const sourceCoordinator = sourceTab?.executionCoordinator ?? null;
    const conversationId = await this.createForkConversation(
      context,
      sourceCoordinator,
      sourceLease,
    );
    if (!conversationId) return null;
    if (!this.isForkSourceCurrent(sourceLease)) {
      await this.plugin.deleteConversation(conversationId).catch(() => {});
      return null;
    }
    let tab: AssembledTabRuntime | null = null;
    try {
      tab = await this.createTab(conversationId);
      if (!tab) {
        await this.plugin.deleteConversation(conversationId).catch(() => {});
        return null;
      }
      if (!this.isForkSourceCurrent(sourceLease)) {
        if (
          this.tabs.get(tab.id) === tab
          && tab.session.userOwnershipRevision !== 0
        ) {
          return tab;
        }
        const removed = await this.discardTab(tab.id);
        if (!removed || this.tabs.get(tab.id) === tab) {
          return tab;
        }
        await this.plugin.deleteConversation(conversationId).catch(() => {});
        return null;
      }
      return tab;
    } catch (error) {
      if (!tab || this.tabs.get(tab.id) !== tab) {
        await this.plugin.deleteConversation(conversationId).catch(() => {});
      }
      throw error;
    }
  }

  async forkInCurrentTab(
    context: ForkContext,
    sourceTab: AssembledTabRuntime | null = this.getActiveTab(),
  ): Promise<boolean> {
    if (!sourceTab) return false;

    const sourceLease: ForkSourceLease = {
      conversationId: context.sourceConversationId,
      tab: sourceTab,
    };
    if (!this.isForkSourceCurrent(sourceLease)) return false;
    const conversationId = await this.createForkConversation(
      context,
      sourceTab.executionCoordinator,
      sourceLease,
    );
    if (!conversationId) return false;
    if (!this.isForkSourceCurrent(sourceLease)) {
      await this.plugin.deleteConversation(conversationId).catch(() => {});
      return false;
    }
    try {
      await sourceTab.controllers.conversationController.switchTo(conversationId);
    } catch (error) {
      await this.plugin.deleteConversation(conversationId).catch(() => {});
      throw error;
    }
    if (
      !this.isTabStateMutable(sourceTab)
      || sourceTab.conversationId !== conversationId
    ) {
      await this.plugin.deleteConversation(conversationId).catch(() => {});
      return false;
    }
    return true;
  }

  private async createForkConversation(
    context: ForkContext,
    sourceCoordinator: AssembledTabRuntime['executionCoordinator'] | null,
    sourceLease: ForkSourceLease | null,
  ): Promise<string | null> {
    const conversation = await this.plugin.createConversation({
      providerId: context.providerId,
      ...(context.sourceSelectedModel ? { selectedModel: context.sourceSelectedModel } : {}),
      ...(context.linkedContentPath ? { linkedContentPath: context.linkedContentPath } : {}),
    });

    const deleteForkConversation = async (): Promise<void> => {
      await this.plugin.deleteConversation(conversation.id).catch(() => {});
    };
    if (!this.isForkSourceCurrent(sourceLease)) {
      await deleteForkConversation();
      return null;
    }

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
      if (!this.isForkSourceCurrent(sourceLease)) {
        await deleteForkConversation();
        return null;
      }
      await this.plugin.updateConversation(conversation.id, {
        messages: context.messages,
        providerState: forkProviderState,
        ...(title && { title }),
      });
      if (!this.isForkSourceCurrent(sourceLease)) {
        await deleteForkConversation();
        return null;
      }
      if (sourceCoordinator && sourceLease?.conversationId) {
        await sourceCoordinator.copyInputsForFork(
          sourceLease.conversationId,
          conversation.id,
          context.resumeAt,
        );
      }
      if (!this.isForkSourceCurrent(sourceLease)) {
        await deleteForkConversation();
        return null;
      }
    } catch (error) {
      await this.plugin.deleteConversation(conversation.id).catch(() => {});
      throw error;
    }

    return conversation.id;
  }

  private isForkSourceCurrent(sourceLease: ForkSourceLease | null): boolean {
    return !this.destroyed
      && (!sourceLease || (
        this.isTabAlive(sourceLease.tab)
        && sourceLease.tab.conversationId === sourceLease.conversationId
      ));
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
    if (!targetTab || !this.isTabAlive(targetTab)) return { status: 'empty' };

    const providerId = getTabProviderId(targetTab, this.plugin);
    const discovery = await this.getSdkCommandDiscovery(targetTab.id, signal);
    throwIfAborted(signal, 'Provider command discovery aborted');
    if (
      !this.isTabAlive(targetTab)
      || getTabProviderId(targetTab, this.plugin) !== providerId
    ) return { status: 'empty' };
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
    if (
      !this.isTabAlive(targetTab)
      || getTabProviderId(targetTab, this.plugin) !== providerId
    ) return { status: 'empty' };
    return normalizeProviderCommandDiscoveryItems(entries);
  }

  private async getSdkCommandDiscovery(
    tabId?: TabId,
    signal?: AbortSignal,
  ): Promise<SdkCommandDiscovery> {
    throwIfAborted(signal, 'Provider command discovery aborted');
    const targetTab = (tabId ? this.tabs.get(tabId) : this.getActiveTab()) ?? null;
    if (!targetTab || !this.isTabAlive(targetTab)) {
      return { result: { status: 'empty' } };
    }

    const providerId = getTabProviderId(targetTab, this.plugin);
    if (!ProviderWorkspaceRegistry.getIfInitialized(providerId)) {
      await ProviderWorkspaceRegistry.ensureInitialized(this.plugin.providerHost, providerId, 'command-picker');
      throwIfAborted(signal, 'Provider command discovery aborted');
      if (
        !this.isTabAlive(targetTab)
        || getTabProviderId(targetTab, this.plugin) !== providerId
      ) return { result: { status: 'empty' } };
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
    if (!this.isCommandContextCurrent(targetTab, providerId, commandContext)) {
      return { result: { status: 'empty' } };
    }
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
      !this.isTabAlive(targetTab)
      || getTabProviderId(targetTab, this.plugin) !== providerId
    ) {
      return { result: { status: 'empty' } };
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
    tab: AssembledTabRuntime,
    providerId: ProviderId,
    warmupContext?: ProviderWarmupContext,
    signal?: AbortSignal,
  ): Promise<ProviderCommandDiscoveryResult<SlashCommand>> {
    throwIfAborted(signal, 'Provider command discovery aborted');
    if (
      !this.isTabAlive(tab)
      || !this.isProviderCommandLoaderAvailable(providerId)
    ) {
      return { status: 'empty' };
    }

    const resolvedWarmupContext = warmupContext
      ?? await this.buildProviderWarmupContext(tab, providerId);
    const context = this.buildProviderCommandContext(
      tab,
      providerId,
      resolvedWarmupContext,
    );
    if (!this.isCommandContextCurrent(tab, providerId, context)) {
      return { status: 'empty' };
    }
    const cached = this.providerRuntimeCommandCache.get(tab.id);
    if (cached && cached.key === context.cacheKey) {
      return cached.result.status === 'ready'
        ? { status: 'ready', items: cached.result.items.map(command => ({ ...command })) as [SlashCommand, ...SlashCommand[]] }
        : cached.result;
    }

    const existing = this.providerRuntimeCommandWarmups.get(tab.id);
    if (existing?.key === context.cacheKey) {
      const result = await this.awaitProviderCommandWarmup(existing, signal);
      return this.isTabAlive(tab) && getTabProviderId(tab, this.plugin) === providerId
        ? result
        : { status: 'empty' };
    }
    this.cancelProviderRuntimeCommandWarmup(tab.id);
    if (!this.isCommandContextCurrent(tab, providerId, context)) {
      return { status: 'empty' };
    }

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
    const result = await this.awaitProviderCommandWarmup(entry, signal);
    return this.isTabAlive(tab) && getTabProviderId(tab, this.plugin) === providerId
      ? result
      : { status: 'empty' };
  }

  private maybePrimeProviderExecution(tab: AssembledTabRuntime): void {
    if (tab.state.isSwitchingConversation) return;
    void this.prewarmProviderTab(tab).catch(() => {});
  }

  private async ensureTabWorkspaceServices(
    tab: AssembledTabRuntime,
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

  private async prewarmProviderTab(tab: AssembledTabRuntime): Promise<void> {
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
    tab: AssembledTabRuntime,
    providerId: ProviderId,
  ): Promise<ProviderWarmupContext> {
    const commandContextRevision = this.tabCommandContextRevisions.get(tab.id) ?? 0;
    const conversationId = tab.conversationId;
    const coordinatorState = tab.executionCoordinator.state === 'disposed'
      ? 'absent'
      : tab.executionCoordinator.state;
    const draftModel = tab.draftModel;
    const lifecycleState = tab.lifecycleState;
    const selectedExternalContextPaths = tab.ui.externalContextSelector.getExternalContexts();
    const conversation = conversationId
      ? await this.plugin.getConversationById(conversationId)
      : null;
    const hasConversationContext = (conversation?.messages.length ?? 0) > 0;
    const externalContextPaths = selectedExternalContextPaths
      ?? (hasConversationContext
        ? conversation?.externalContextPaths ?? []
        : this.plugin.settings.persistentExternalContextPaths ?? []);
    const baseContext: Omit<ProviderWarmupContext, 'warmupMode'> = {
      commandContextRevision,
      coordinatorState,
      conversation,
      externalContextPaths,
      hasResumableNativeSeed: Boolean(
        conversation?.sessionId
        || conversation?.resumeAtMessageId
        || conversation?.providerState,
      ),
      plugin: this.plugin.providerHost,
      tab: {
        conversationId,
        draftModel,
        lifecycleState,
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
    if (!this.advanceTabCommandContextRevision(tabId)) return;
    this.providerCommandDiscoveryStores.get(tabId)?.invalidate();
  }

  private advanceTabCommandContextRevision(tabId: TabId): boolean {
    const tab = this.tabs.get(tabId);
    if (!tab || !this.isTabStateMutable(tab)) return false;

    this.tabCommandContextRevisions.set(
      tabId,
      (this.tabCommandContextRevisions.get(tabId) ?? 0) + 1,
    );
    this.cancelProviderRuntimeCommandWarmup(tabId);
    this.providerRuntimeCommandCache.delete(tabId);
    return true;
  }

  private cancelProviderRuntimeCommandWarmup(tabId: TabId): void {
    const warmup = this.providerRuntimeCommandWarmups.get(tabId);
    if (!warmup) {
      return;
    }
    warmup.abortController.abort();
    this.providerRuntimeCommandWarmups.delete(tabId);
  }

  private releaseTabRuntimeMetadata(tabId: TabId): readonly unknown[] {
    const errors: unknown[] = [];
    try {
      this.cancelProviderRuntimeCommandWarmup(tabId);
    } catch (error) {
      errors.push(error);
    }
    try {
      this.providerCommandDiscoveryStores.get(tabId)?.invalidate();
    } catch (error) {
      errors.push(error);
    } finally {
      this.providerRuntimeCommandWarmups.delete(tabId);
      this.providerRuntimeCommandCache.delete(tabId);
      this.providerCommandDiscoveryStores.delete(tabId);
      this.tabCommandContextRevisions.delete(tabId);
      this.tabActivationRevisions.delete(tabId);
    }
    return errors;
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
    tab: AssembledTabRuntime,
    providerId: ProviderId,
    context: ProviderCommandContext,
  ): boolean {
    return this.isTabAlive(tab)
      && getTabProviderId(tab, this.plugin) === providerId
      && tab.conversationId === context.tab.conversationId
      && (this.tabCommandContextRevisions.get(tab.id) ?? 0) === context.commandContextRevision
      && this.plugin.providerHost.executionLifecycleRegistry.getProviderGeneration(providerId)
        === context.providerGeneration
      && this.getProviderResourceGeneration(providerId) === context.resourceGeneration;
  }

  private buildProviderCommandContext(
    tab: AssembledTabRuntime,
    providerId: ProviderId,
    warmupContext: ProviderWarmupContext,
  ): ProviderCommandContext {
    const loader = ProviderWorkspaceRegistry.getCommandLoader(
      providerId,
    );
    const fingerprint = loader?.getCacheFingerprint(this.plugin.settings) ?? 'catalog';
    const commandContextRevision = warmupContext.commandContextRevision;
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
    tab: AssembledTabRuntime,
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
        onBeforeRetry: () => {
          this.advanceTabCommandContextRevision(tabId);
        },
        resolveTimeoutMs: () => {
          const tab = this.tabs.get(tabId);
          if (!tab || !this.isTabAlive(tab)) return undefined;
          const providerId = getTabProviderId(tab, this.plugin);
          return ProviderRegistry.getCapabilities(providerId).commandDiscoveryDeadline
            === 'provider-owned'
            ? null
            : undefined;
        },
      },
    );
    this.providerCommandDiscoveryStores.set(tabId, discovery);
    return discovery;
  }

  private getProviderCatalogConfig(tab: TabProviderCatalogContext) {
    if (this.destroyed || tab.lifecycleState === 'closing') return null;

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

  /** Synchronously fences new work while preserving state for the shutdown snapshot. */
  beginShutdown(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.shutdownSnapshotOpen = true;
    for (const tab of this.tabs.values()) {
      tab.session.pauseIntentAdmission();
    }
  }

  /** Seals the final identity snapshot so late runtime callbacks cannot mutate tab state. */
  sealShutdownSnapshot(): void {
    this.shutdownSnapshotOpen = false;
  }

  /** Cancels and drains active tab work while terminal binding callbacks remain accepted. */
  async drainForShutdownSnapshot(): Promise<void> {
    this.beginShutdown();
    if (!this.shutdownDrainPromise) {
      this.shutdownDrainPromise = this.drainForShutdownSnapshotOnce();
    }
    await this.shutdownDrainPromise;
  }

  private async drainForShutdownSnapshotOnce(): Promise<void> {
    const drainErrors: unknown[] = [];
    drainErrors.push(...await this.drainInFlightCloseOperations());
    try {
      await this.invalidateAndDrainConversationNavigation();
    } catch (error) {
      drainErrors.push(error);
    }
    try {
      await this.waitForTabSwitchIdle();
    } catch (error) {
      drainErrors.push(error);
    }
    this.reconcileShutdownSnapshotOwner();
    const results = await Promise.all(
      Array.from(this.tabs.values()).map(tab => drainTabForShutdownSnapshot(tab)),
    );
    drainErrors.push(...results.flatMap(result => (
      result.cleanupFailures.map(failure => failure.error)
    )));
    throwCollectedErrors(drainErrors, 'Failed to drain every tab for shutdown persistence');
  }

  private async drainInFlightCloseOperations(): Promise<unknown[]> {
    const closeErrors: unknown[] = [];
    while (this.inFlightCloseOperations.size > 0) {
      const results = await Promise.allSettled([...this.inFlightCloseOperations]);
      for (const result of results) {
        if (result.status === 'rejected') closeErrors.push(result.reason);
      }
    }
    return closeErrors;
  }

  private reconcileShutdownSnapshotOwner(): void {
    if (this.activeTabId === null) return;

    const activeTab = this.activeTabId ? this.tabs.get(this.activeTabId) ?? null : null;
    if (activeTab && activeTab.lifecycleState !== 'closing') {
      if (this.committedTabIds.has(activeTab.id)) {
        this.committedActiveTabId = activeTab.id;
      }
      return;
    }

    const replacement = Array.from(this.tabs.values())
      .find(tab => tab.lifecycleState !== 'closing') ?? null;
    this.activeTabId = replacement?.id ?? null;
    this.committedActiveTabId = replacement && this.committedTabIds.has(replacement.id)
      ? replacement.id
      : null;
  }

  /** Destroys all tabs and cleans up resources. */
  async destroy(): Promise<void> {
    if (!this.destructionPromise) {
      this.destructionPromise = this.destroyOnce();
    }
    await this.destructionPromise;
  }

  private async destroyOnce(): Promise<void> {
    this.beginShutdown();
    this.sealShutdownSnapshot();
    const destroyErrors: unknown[] = [];
    destroyErrors.push(...await this.drainInFlightCloseOperations());
    try {
      await this.invalidateAndDrainConversationNavigation();
    } catch (error) {
      destroyErrors.push(error);
    }
    try {
      await this.waitForTabSwitchIdle();
    } catch (error) {
      destroyErrors.push(error);
    }
    try {
      await this.provisionalCleanupPromise;
    } catch (error) {
      destroyErrors.push(error);
    }
    const tabs = Array.from(this.tabs.values());
    const metadataTabIds = new Set<TabId>([
      ...tabs.map(tab => tab.id),
      ...this.providerRuntimeCommandWarmups.keys(),
      ...this.providerRuntimeCommandCache.keys(),
      ...this.providerCommandDiscoveryStores.keys(),
      ...this.tabCommandContextRevisions.keys(),
      ...this.tabActivationRevisions.keys(),
    ]);
    for (const tabId of metadataTabIds) {
      destroyErrors.push(...this.releaseTabRuntimeMetadata(tabId));
    }

    // Each tab drains background work and persists its final state during teardown.
    const teardownResults = await Promise.allSettled(tabs.map(tab => destroyTab(tab)));
    for (const result of teardownResults) {
      if (result.status === 'rejected') {
        destroyErrors.push(result.reason);
      }
    }
    const finalMetadataTabIds = new Set<TabId>([
      ...tabs.map(tab => tab.id),
      ...this.providerRuntimeCommandWarmups.keys(),
      ...this.providerRuntimeCommandCache.keys(),
      ...this.providerCommandDiscoveryStores.keys(),
      ...this.tabCommandContextRevisions.keys(),
      ...this.tabActivationRevisions.keys(),
    ]);
    for (const tabId of finalMetadataTabIds) {
      destroyErrors.push(...this.releaseTabRuntimeMetadata(tabId));
    }
    this.tabs.clear();
    this.committedTabIds.clear();
    this.providerRuntimeCommandWarmups.clear();
    this.providerRuntimeCommandCache.clear();
    this.providerCommandDiscoveryStores.clear();
    this.tabCommandContextRevisions.clear();
    this.tabActivationRevisions.clear();
    this.closingTabIds.clear();
    this.activeTabId = null;
    this.committedActiveTabId = null;

    throwCollectedErrors(destroyErrors, 'Failed to destroy every tab cleanly');
  }
}
