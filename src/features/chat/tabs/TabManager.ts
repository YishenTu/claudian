import type { AppTabManagerState } from '@/core/bootstrap/tabManagerState';
import type { ProviderId } from '@/core/providers/types';
import type { ChatFeatureHost } from '@/features/chat/ChatFeatureHost';
import type { TabBarItem, TabId, TabManagerInterface, TabManagerViewHost } from '@/features/chat/tabs/ChatTab';
import { type ForkTargetHost, openForkTarget } from '@/features/chat/tabs/forking/ForkTarget';
import { TabCommandDiscovery } from '@/features/chat/tabs/TabCommandDiscovery';
import {
  type OpenConversationOptions,
  TabConversationNavigation,
} from '@/features/chat/tabs/TabConversationNavigation';
import { TabHydration } from '@/features/chat/tabs/TabHydration';
import {
  createTabSessionState,
  generateTabId,
  reconcileBlankTabIdentity,
} from '@/features/chat/tabs/TabIdentity';
import {
  activateTab,
  commitProvisionalTab,
  deactivateTab,
  destroyTab,
  drainTabForShutdownSnapshot,
  getTabTitle,
} from '@/features/chat/tabs/TabLifecycle';
import { onProviderAvailabilityChanged } from '@/features/chat/tabs/tabProviderLifecycle';
import { TabProviderPresence } from '@/features/chat/tabs/TabProviderPresence';
import { createTabRuntime } from '@/features/chat/tabs/TabRuntimeFactory';
import type { TabSessionState } from '@/features/chat/tabs/TabSession';
import { TabSwitchScheduler } from '@/features/chat/tabs/TabSwitchScheduler';
import type { AssembledTabRuntime, TabManagerCallbacks, TabMembershipView } from '@/features/chat/tabs/types';
import type { VaultMentionDataProvider } from '@/shared/mention/VaultMentionDataProvider';

type CreateTabOptions = {
  activate?: boolean;
  draftModel?: string;
  providerId?: ProviderId | null;
  lifecycleState?: Extract<AssembledTabRuntime['lifecycleState'], 'provisional' | 'open'>;
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
  private plugin: ChatFeatureHost;
  private containerEl: HTMLElement;
  private view: TabManagerViewHost;

  private readonly tabs = new Map<TabId, TabSessionState | AssembledTabRuntime>();
  private activeTabId: TabId | null = null;
  private readonly committedTabIds = new Set<TabId>();
  private committedActiveTabId: TabId | null = null;
  private callbacks: TabManagerCallbacks;
  private readonly commandDiscovery: TabCommandDiscovery;
  private readonly forkTargetHost: ForkTargetHost;
  private readonly providerPresence: TabProviderPresence;
  private readonly hydration: TabHydration;
  private readonly switchScheduler: TabSwitchScheduler;
  private readonly navigation: TabConversationNavigation;
  private tabActivationRevisions = new Map<TabId, number>();
  private assemblingTabIds = new Set<TabId>();
  private closingTabIds = new Set<TabId>();
  private inFlightCloseOperations = new Set<Promise<boolean>>();
  private liveTabReplacementPromise: Promise<AssembledTabRuntime | null> | null = null;
  private destructionPromise: Promise<void> | null = null;
  private shutdownDrainPromise: Promise<void> | null = null;
  private destroyed = false;
  private shutdownSnapshotOpen = false;

  constructor(
    plugin: ChatFeatureHost,
    containerEl: HTMLElement,
    view: TabManagerViewHost,
    callbacks: TabManagerCallbacks,
    private readonly mentionDataProvider: VaultMentionDataProvider,
  ) {
    this.plugin = plugin;
    this.containerEl = containerEl;
    this.view = view;
    this.callbacks = callbacks;
    // The single membership projection handed to collaborators; only this manager mutates membership.
    const membership: TabMembershipView = {
      isDestroyed: () => this.destroyed,
      getActiveTabId: () => this.activeTabId,
      getTab: tabId => this.getTab(tabId),
      getAllTabs: () => this.getAllTabs(),
      getTabIdentities: () => this.getTabIdentities(),
      isTabAlive: tab => this.#isTabAlive(tab),
      isTabStateMutable: tab => this.#isTabStateMutable(tab),
      isCloseClaimed: tabId => this.closingTabIds.has(tabId),
    };
    this.commandDiscovery = new TabCommandDiscovery(plugin, membership);
    this.forkTargetHost = {
      plugin,
      membership,
      createTab: conversationId => this.createTab(conversationId),
      discardTab: tabId => this.discardTab(tabId),
      shouldForkToNewTab: () => this.callbacks.shouldForkToNewTab?.() ?? false,
    };
    this.providerPresence = new TabProviderPresence(
      plugin,
      membership,
      providerId => [...this.tabs.values()].some(candidate => (
        candidate.providerId === providerId
        && candidate.lifecycleState !== 'closing'
        && this.committedTabIds.has(candidate.id)
      )),
    );
    this.hydration = new TabHydration({
      isTabAlive: tab => this.#isTabAlive(tab),
      ensureWorkspaceServices: (tab, providerId, reason) => (
        this.providerPresence.ensureWorkspaceServices(tab, providerId, reason)
      ),
      onRetry: (tab) => {
        if (!this.#isTabAlive(tab)) return;
        void this.switchToTab(tab.id);
      },
    });
    this.switchScheduler = new TabSwitchScheduler({
      canStart: (tabId) => {
        const identity = this.tabs.get(tabId);
        return !!identity && this.#isTabAlive(identity);
      },
      isDestroyed: () => this.destroyed,
      getActiveTabId: () => this.activeTabId,
      executeSwitch: (tabId, onActivationStarted) => this.#executeSwitch(tabId, onActivationStarted),
    });
    this.navigation = new TabConversationNavigation({
      plugin,
      view,
      membership,
      switchToTab: tabId => this.switchToTab(tabId),
      createTab: (conversationId, options) => this.createTab(conversationId, undefined, options),
      closeTab: tabId => this.closeTab(tabId),
      discardTab: tabId => this.discardTab(tabId),
    });
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
      ? this.switchScheduler.reserveIntent(runtimeTabId)
      : null;
    try {
      return await this.#createReservedTab(
        conversationId,
        runtimeTabId,
        options,
        activationRequestRevision,
      );
    } finally {
      this.assemblingTabIds.delete(runtimeTabId);
    }
  }

  async #createReservedTab(
    conversationId: string | null | undefined,
    runtimeTabId: TabId,
    options: CreateTabOptions,
    activationRequestRevision: number | null,
    restoredIdentity?: TabSessionState,
  ): Promise<AssembledTabRuntime | null> {
    if (this.destroyed) return null;

    const {
      activate = true,
      draftModel,
      providerId,
      lifecycleState = 'open',
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
        mentionDataProvider: this.mentionDataProvider,
        conversation: conversation ?? undefined,
        tabId: runtimeTabId,
        initialState: restoredIdentity,
        ...(typeof draftModel === 'string' ? { draftModel } : {}),
        ...(providerId !== undefined ? { providerId } : {}),
        lifecycleState,
        getProviderCatalogConfig: runtime => this.commandDiscovery.getProviderCatalogConfig(runtime),
        isRuntimeLive: runtime => this.#isTabAlive(runtime),
        forkRequestCallback: (forkContext) => {
          const sourceTab = tab;
          if (!sourceTab || !this.#isTabAlive(sourceTab)) return Promise.resolve();
          return openForkTarget(this.forkTargetHost, sourceTab, forkContext);
        },
        openConversation: (id) => {
          const sourceTab = tab;
          if (!sourceTab || !this.#isTabAlive(sourceTab)) return Promise.resolve();
          return this.navigation.open(id, {}, sourceTab);
        },
        onStreamingChanged: (runtime, isStreaming) => {
          if (!this.#isTabStateMutable(runtime)) return;
          this.callbacks.onTabStreamingChanged?.(runtime.id, isStreaming);
        },
        onWorkChanged: runtime => {
          if (!this.#isTabStateMutable(runtime)) return;
          this.callbacks.onTabWorkChanged?.(runtime.id);
        },
        onRewindingChanged: (runtime, isRewinding) => {
          if (!this.#isTabStateMutable(runtime)) return;
          this.callbacks.onTabRewindingChanged?.(runtime.id, isRewinding);
        },
        onAttentionChanged: (runtime, attention) => {
          if (!this.#isTabStateMutable(runtime)) return;
          this.callbacks.onTabAttentionChanged?.(runtime.id, attention);
        },
        captureReviewableSettlement: (runtime, outcome) => {
          const shouldReport = this.#isTabStateMutable(runtime) && this.activeTabId !== runtime.id;
          const activationRevision = this.tabActivationRevisions.get(runtime.id) ?? 0;
          return () => {
            if (
              shouldReport
              && this.#isTabStateMutable(runtime)
              && (this.tabActivationRevisions.get(runtime.id) ?? 0) === activationRevision
            ) {
              runtime.state.markReviewRequired(outcome);
            }
          };
        },
        onConversationIdChanged: (runtime, nextConversationId) => {
          if (!this.#isTabOwned(runtime)) return;
          if (this.destroyed && !this.shutdownSnapshotOpen) return;
          if (!this.destroyed) {
            this.commandDiscovery.invalidateTab(runtime.id);
          }
          this.callbacks.onTabConversationChanged?.(runtime.id, nextConversationId);
          this.providerPresence.startForTab(runtime);
        },
        onDraftModelChanged: (runtime, draftModel) => {
          if (!this.#isTabStateMutable(runtime)) return;
          this.callbacks.onTabDraftChanged?.(runtime.id, draftModel);
          this.providerPresence.startForTab(runtime);
        },
        onCommandContextChanged: runtime => {
          this.commandDiscovery.invalidateTab(runtime.id);
        },
        onProviderChanged: async (runtime, providerId) => {
          if (!this.#isTabAlive(runtime)) return;
          this.commandDiscovery.invalidateTab(runtime.id);
          if (!await this.providerPresence.ensureWorkspaceServices(
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

      if (this.destroyed || (restoredIdentity && (
        !this.#isTabAlive(restoredIdentity)
        || restoredIdentity.conversationId !== tab.conversationId
        || restoredIdentity.draftModel !== tab.draftModel
        || restoredIdentity.providerId !== tab.providerId
      ))) {
        const abandonedTab = tab;
        tab = null;
        const rollbackErrors: unknown[] = [];
        try {
          await destroyTab(abandonedTab);
        } catch (rollbackError) {
          rollbackErrors.push(rollbackError);
        }
        rollbackErrors.push(...this.#releaseTabRuntimeMetadata(runtimeTabId));
        throwCollectedErrors(
          rollbackErrors,
          'Failed to roll back a tab assembled after manager destruction',
        );
        return null;
      }

      this.tabActivationRevisions.set(tab.id, 0);
      this.commandDiscovery.registerTab(tab.id);
    } catch (error) {
      const rollbackErrors: unknown[] = [];
      if (tab) {
        try {
          await destroyTab(tab);
        } catch (rollbackError) {
          rollbackErrors.push(rollbackError);
        }
      }
      rollbackErrors.push(...this.#releaseTabRuntimeMetadata(runtimeTabId));
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
        await this.switchScheduler.request(
          tab.id,
          true,
          activationRequestRevision ?? this.switchScheduler.reserveIntent(tab.id),
          previousTabId => {
            rollbackActiveTabId = previousTabId;
          },
        );
      }

      if (!this.#isTabAlive(tab)) return null;
    } catch (error) {
      const rollbackErrors = await this.#rollbackAdmittedTab(tab, rollbackActiveTabId);
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
    this.providerPresence.startForTab(tab);
    if (this.activeTabId === tab.id) this.committedActiveTabId = tab.id;

    try {
      this.callbacks.onTabCreated?.(tab);
    } catch {
      // Admission is committed; an observer failure must not retract published membership.
    }
    return tab;
  }

  async #rollbackAdmittedTab(
    tab: AssembledTabRuntime,
    previousActiveTabId: TabId | null,
  ): Promise<unknown[]> {
    const rollbackErrors: unknown[] = [];
    if (this.getTab(tab.id) !== tab) {
      rollbackErrors.push(...this.#releaseTabRuntimeMetadata(tab.id));
      return rollbackErrors;
    }

    tab.session.beginClose();
    rollbackErrors.push(...this.#releaseTabRuntimeMetadata(tab.id));

    if (this.activeTabId === tab.id) {
      try {
        deactivateTab(tab);
      } catch (error) {
        rollbackErrors.push(error);
      }
      this.activeTabId = null;

      const previousTab = previousActiveTabId
        ? this.getTab(previousActiveTabId) ?? null
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
    rollbackErrors.push(...this.#releaseTabRuntimeMetadata(tab.id));

    return rollbackErrors;
  }

  /**
   * Switches to a different tab.
   * @param tabId The tab to switch to.
   */
  async switchToTab(tabId: TabId): Promise<void> {
    const identity = this.tabs.get(tabId);
    if (!identity || !this.#isTabAlive(identity)) return;
    const previousTabId = this.activeTabId;
    await this.switchScheduler.request(tabId, false, this.switchScheduler.reserveIntent(tabId));
    if (this.activeTabId !== tabId || previousTabId === tabId) return;

    try {
      this.callbacks.onActiveTabCommitted?.(previousTabId, tabId);
    } catch {
      // Selection is committed; an observer failure must not roll it back.
    }
  }

  /** Activation and rollback body; the scheduler runs one at a time after its liveness check. */
  async #executeSwitch(
    tabId: TabId,
    onActivationStarted?: (previousTabId: TabId | null) => void,
  ): Promise<void> {
    const identity = this.tabs.get(tabId);
    if (!identity) return;
    const previousTabId = this.activeTabId;
    let activeTabChangePublicationStarted = false;
    let switchRolledBack = false;
    onActivationStarted?.(previousTabId);

    let tab = this.getTab(tabId) ?? null;
    try {
      if (!tab) {
        this.assemblingTabIds.add(tabId);
        try {
          tab = await this.#createReservedTab(identity.conversationId, tabId, {
            activate: false, draftModel: identity.draftModel ?? undefined, providerId: identity.providerId,
          }, null, identity);
        } finally {
          this.assemblingTabIds.delete(tabId);
        }
        if (!tab || !this.#isTabAlive(tab)) return;
      }
      // Deactivate current tab
      if (previousTabId && previousTabId !== tabId) {
        const currentTab = this.getTab(previousTabId);
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

      if (await this.hydration.hydrateActivatedTab(tab) !== 'ready') return;
      try {
        this.callbacks.onTabSwitched?.(previousTabId, tabId);
      } catch {
        // Selection is committed; a completion observer cannot roll it back.
      }
    } catch (error) {
      switchRolledBack = true;
      const rollbackErrors = tab ? this.#restorePreviousTabAfterFailedSwitch(
        tab,
        previousTabId,
        activeTabChangePublicationStarted,
      ) : [];
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
        && tab
        && this.#isTabAlive(tab)
      ) {
        this.committedActiveTabId = tabId;
      }
    }
  }

  #restorePreviousTabAfterFailedSwitch(
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
      ? this.getTab(previousTabId) ?? null
      : null;
    if (
      !this.destroyed
      && previousTab
      && this.#isTabOwned(previousTab)
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

  getTabSwitchRequestRevision(): number {
    return this.switchScheduler.requestRevision;
  }

  async waitForTabSwitchIdle(): Promise<void> {
    await this.switchScheduler.waitForIdle();
  }

  /**
   * Closes a tab.
   * @param tabId The tab to close.
   * @param force If true, close even if streaming.
   * @returns True if the tab was closed.
   */
  async closeTab(tabId: TabId, force = false): Promise<boolean> {
    return this.#trackCloseOperation(this.#closeTabWithPolicy(tabId, force, true));
  }

  /**
   * Discards a manager-owned tab even when it is the last blank draft.
   * A fresh draft is installed when needed to preserve the live-manager invariant.
   */
  async discardTab(tabId: TabId): Promise<boolean> {
    return this.#trackCloseOperation(this.#closeTabWithPolicy(tabId, true, false));
  }

  #trackCloseOperation(operation: Promise<boolean>): Promise<boolean> {
    const trackedOperation = operation.finally(() => {
      this.inFlightCloseOperations.delete(trackedOperation);
    });
    this.inFlightCloseOperations.add(trackedOperation);
    return trackedOperation;
  }

  async #closeTabWithPolicy(
    tabId: TabId,
    force: boolean,
    preserveLastBlank: boolean,
  ): Promise<boolean> {
    const tab = this.tabs.get(tabId);
    const runtime = this.getTab(tabId);
    if (!tab) {
      return false;
    }
    if (tab.lifecycleState === 'closing' || this.closingTabIds.has(tabId)) {
      return false;
    }

    // Rewind is a provider/local-state transaction and cannot be interrupted by teardown.
    if (runtime?.state.isRewinding) {
      return false;
    }

    // Only an explicit force may interrupt the foreground turn.
    if (runtime?.session.hasActiveTurn && !force) {
      return false;
    }

    // If this is the last tab and it's already empty (no conversation),
    // don't close it - it's already a blank draft container.
    if (
      preserveLastBlank
      && this.tabs.size === 1
      && !tab.conversationId
      && (!runtime || runtime.state.messages.length === 0)
    ) {
      return false;
    }

    // Reserve the close before fallible replacement assembly without fencing state callbacks.
    this.closingTabIds.add(tabId);
    runtime?.session.pauseIntentAdmission();
    try {
      const tabIdsBefore = Array.from(this.tabs.keys());
      const closingIndex = tabIdsBefore.indexOf(tabId);
      let successor = this.#findLiveTabAfterClose(tabIdsBefore, closingIndex);
      if (!successor) {
        successor = await this.#ensureLiveTabReplacement();
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
          || !this.#isTabAvailableToAdmittedClose(activeTab)
        ) {
          return false;
        }
      }

      // Replacement admission is complete; teardown is now irreversible.
      if ('session' in tab) tab.session.beginClose();
      else tab.lifecycleState = 'closing';
      this.committedTabIds.delete(tabId);
      if (this.committedActiveTabId === tabId) {
        this.committedActiveTabId = null;
      }

      const closeErrors: unknown[] = [];

      // Prevent in-flight hydration from mutating this tab while close awaits persistence.
      closeErrors.push(...this.#releaseTabRuntimeMetadata(tabId));

      // Save conversation before closing. Cleanup remains mandatory if save fails.
      try {
        await runtime?.controllers.conversationController.save();
      } catch (error) {
        closeErrors.push(error);
      }

      // Destroy tab resources, then release manager ownership even if teardown fails.
      try {
        if (runtime) await destroyTab(runtime);
      } catch (error) {
        closeErrors.push(error);
      }
      closeErrors.push(...this.#releaseTabRuntimeMetadata(tabId));
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
          await this.#reconcileLiveTabAfterClose(tabIdsBefore, closingIndex);
        } catch (error) {
          closeErrors.push(error);
        }
      }

      throwCollectedErrors(closeErrors, `Failed to close tab ${tabId} cleanly`);
      return true;
    } finally {
      this.closingTabIds.delete(tabId);
      runtime?.session.resumeIntentAdmission();
      if (runtime && this.#isTabStateMutable(runtime) && runtime.session.acceptsIntents) {
        runtime.controllers.inputController.resumeQueuedTurnAfterIntentAdmission();
      }
    }
  }

  async #reconcileLiveTabAfterClose(
    tabIdsBefore: readonly TabId[],
    closingIndex: number,
  ): Promise<void> {
    if (this.destroyed) return;

    const activeTab = this.getActiveTab();
    if (activeTab && this.#isTabAlive(activeTab)) return;

    const replacement = await this.#resolveLiveTabAfterClose(tabIdsBefore, closingIndex);
    if (!replacement || !this.#isTabAlive(replacement)) return;
    if (this.activeTabId !== replacement.id) {
      await this.switchToTab(replacement.id);
    }
  }

  async #resolveLiveTabAfterClose(
    tabIdsBefore: readonly TabId[],
    closingIndex: number,
  ): Promise<TabSessionState | null> {
    if (this.destroyed) return null;

    let replacement = this.#findLiveTabAfterClose(tabIdsBefore, closingIndex);
    if (!replacement) {
      try {
        replacement = await this.#ensureLiveTabReplacement();
      } catch (error) {
        replacement = this.#findLiveTabAfterClose(tabIdsBefore, closingIndex);
        if (!replacement) throw error;
      }
    }
    return replacement && this.#isTabAlive(replacement)
      ? replacement
      : null;
  }

  #findLiveTabAfterClose(
    tabIdsBefore: readonly TabId[],
    closingIndex: number,
  ): TabSessionState | null {
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
      .find((candidate): candidate is TabSessionState => (
        !!candidate && this.#isTabAlive(candidate)
      )) ?? null;
  }

  async #ensureLiveTabReplacement(): Promise<TabSessionState | null> {
    if (this.destroyed) return null;

    const existing = Array.from(this.tabs.values())
      .find(tab => this.#isTabAlive(tab));
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

  #isTabAlive(tab: TabSessionState): boolean {
    return !this.destroyed && this.#isTabAvailableToAdmittedClose(tab);
  }

  #isTabStateMutable(tab: TabSessionState): boolean {
    return !this.destroyed && this.#isTabOwned(tab);
  }

  #isTabAvailableToAdmittedClose(tab: TabSessionState): boolean {
    return !this.closingTabIds.has(tab.id) && this.#isTabOwned(tab);
  }

  #isTabOwned(tab: TabSessionState): boolean {
    return tab.lifecycleState !== 'closing'
      && this.tabs.get(tab.id) === tab;
  }

  // ============================================
  // Tab Queries
  // ============================================

  /** Gets the currently active tab. */
  getActiveTab(): AssembledTabRuntime | null {
    return this.activeTabId ? this.getTab(this.activeTabId) ?? null : null;
  }

  /** Gets the active tab ID. */
  getActiveTabId(): TabId | null {
    return this.activeTabId;
  }

  /** Gets a tab by ID. */
  getTab(tabId: TabId): AssembledTabRuntime | null {
    const tab = this.tabs.get(tabId);
    return tab && 'state' in tab ? tab : null;
  }

  /** Gets assembled runtimes; inactive restored identities are available separately. */
  getAllTabs(): AssembledTabRuntime[] {
    return [...this.tabs.values()].filter((tab): tab is AssembledTabRuntime => 'state' in tab);
  }

  /** Ordered membership for navigation and persistence, including unassembled restored tabs. */
  getTabIdentities(): readonly Readonly<TabSessionState>[] {
    return [...this.tabs.values()];
  }

  /** True while the tab has any user-visible foreground or background work in progress. */
  isTabWorking(tabId: TabId): boolean {
    return this.getTab(tabId)?.session.isWorking ?? false;
  }

  /** Reconciles blank drafts after provider/model availability changes. */
  reconcileProviderAvailability(): void {
    for (const tab of this.tabs.values()) {
      if (tab.lifecycleState === 'closing') continue;
      const runtime = this.getTab(tab.id);
      const changed = runtime ? onProviderAvailabilityChanged(runtime, this.plugin) : reconcileBlankTabIdentity(tab, this.plugin);
      if (changed) {
        this.callbacks.onTabDraftChanged?.(tab.id, tab.draftModel);
        this.callbacks.onTabProviderChanged?.(tab.id, tab.providerId);
      }
      this.providerPresence.startForTab(tab);
    }
  }

  async resetConversationTabs(conversationId: string): Promise<void> {
    const errors: unknown[] = [];
    for (const identity of this.tabs.values()) {
      if (identity.conversationId !== conversationId || !this.#isTabStateMutable(identity)) continue;
      const runtime = this.getTab(identity.id);
      try {
        if (runtime) {
          runtime.controllers.inputController.cancelStreaming();
          await runtime.controllers.conversationController.createNew({ force: true });
        } else {
          const blank = createTabSessionState(this.plugin.settings, null, { tabId: identity.id });
          this.tabs.set(identity.id, blank);
          this.providerPresence.startForTab(blank);
          this.callbacks.onTabConversationChanged?.(blank.id, null);
          this.callbacks.onTabDraftChanged?.(blank.id, blank.draftModel);
        }
      } catch (error) { errors.push(error); }
    }
    if (errors.length > 0) throw errors[0];
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
          ? { draftModel: tab.draftModel, providerId: tab.providerId }
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

  /** Restores open shells without provider execution, then activates exactly one final target. */
  async restoreState(state: AppTabManagerState): Promise<void> {
    for (const tabState of state.openTabs) {
      if (
        tabState.conversationId
        && !this.plugin.getCachedConversation(tabState.conversationId)
      ) {
        continue;
      }
      if (this.destroyed) return;
      if (this.tabs.has(tabState.tabId) || this.assemblingTabIds.has(tabState.tabId)) continue;
      const identity = createTabSessionState(this.plugin.settings,
        tabState.conversationId ? this.plugin.getCachedConversation(tabState.conversationId) : null,
        { ...tabState, lifecycleState: 'open' });
      this.tabs.set(identity.id, identity);
      this.committedTabIds.add(identity.id);
      this.providerPresence.startForTab(identity);
    }

    const targetIds = new Set([
      ...(state.activeTabId && this.tabs.has(state.activeTabId) ? [state.activeTabId] : []),
      ...this.tabs.keys(),
    ]);
    for (const targetId of targetIds) {
      if (this.destroyed) return;
      try {
        await this.switchToTab(targetId);
        if (this.getActiveTab()) return;
      } catch (error) {
        // Keep failed shells retryable and continue restoring a usable workspace.
        // Once assembly succeeded, preserve the normal activation rollback/error contract.
        if (this.getTab(targetId)) throw error;
      }
    }

    await this.createTab();
  }

  /** Checks if more tabs can be created. */
  canCreateTab(): boolean {
    return !this.destroyed;
  }

  /**
   * Records explicit user retention: claims ownership of each live runtime and commits it
   * when it is still a provisional preview. Unknown, unassembled, and closing IDs are ignored.
   */
  retainTabs(tabIds: readonly TabId[]): void {
    for (const tabId of tabIds) {
      const tab = this.getTab(tabId);
      if (!tab || !this.#isTabAlive(tab)) continue;
      commitProvisionalTab(tab);
    }
  }

  /** Removes replaceable dual-mode previews while retaining open work. */
  async discardProvisionalTabs(): Promise<void> {
    await this.navigation.discardProvisionalTabs();
  }

  // ============================================
  // Tab Bar Data
  // ============================================

  /** Gets data for rendering the tab bar. */
  getTabBarItems(): TabBarItem[] {
    const items: TabBarItem[] = [];
    let index = 1;

    for (const tab of this.tabs.values()) {
      const runtime = this.getTab(tab.id);
      items.push({
        id: tab.id,
        index: index++,
        title: getTabTitle(tab, this.plugin),
        isActive: tab.id === this.activeTabId,
        isWorking: this.isTabWorking(tab.id),
        attention: runtime?.state.attention ?? null,
        canClose: !runtime?.state.isRewinding && (this.tabs.size > 1 || !runtime?.session.hasActiveTurn),
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
   * @param options Controls tab creation behavior.
   */
  async openConversation(
    conversationId: string,
    options: OpenConversationOptions = {},
  ): Promise<void> {
    await this.navigation.open(conversationId, options, null);
  }

  /**
   * Creates a new conversation in the active tab.
   */
  async createNewConversation(): Promise<void> {
    const activeTab = this.getActiveTab();
    if (activeTab) {
      await activeTab.controllers.conversationController.createNew();
    }
  }

  invalidateProviderCommandCaches(providerIds?: ProviderId | ProviderId[]): void {
    this.commandDiscovery.invalidateProviders(providerIds);
  }

  invalidateProviderResources(
    providerIds: ProviderId | ProviderId[],
    generation: number,
  ): void {
    this.commandDiscovery.invalidateProviderResources(providerIds, generation);
  }

  #releaseTabRuntimeMetadata(tabId: TabId): readonly unknown[] {
    const errors = this.commandDiscovery.releaseTab(tabId);
    this.tabActivationRevisions.delete(tabId);
    return errors;
  }

  // ============================================
  // Cleanup
  // ============================================

  /** Synchronously fences new work while preserving state for the shutdown snapshot. */
  beginShutdown(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.shutdownSnapshotOpen = true;
    for (const tab of this.getAllTabs()) tab.session.beginShutdown();
  }

  /** Seals the final identity snapshot so late runtime callbacks cannot mutate tab state. */
  sealShutdownSnapshot(): void {
    this.shutdownSnapshotOpen = false;
    for (const tab of this.getAllTabs()) tab.session.sealIdentity();
  }

  /** Cancels and drains active tab work while terminal binding callbacks remain accepted. */
  async drainForShutdownSnapshot(): Promise<void> {
    this.beginShutdown();
    if (!this.shutdownDrainPromise) {
      this.shutdownDrainPromise = this.#drainForShutdownSnapshotOnce();
    }
    await this.shutdownDrainPromise;
  }

  async #drainForShutdownSnapshotOnce(): Promise<void> {
    const drainErrors: unknown[] = [];
    drainErrors.push(...await this.#drainInFlightCloseOperations());
    try {
      await this.navigation.invalidateAndDrain();
    } catch (error) {
      drainErrors.push(error);
    }
    try {
      await this.waitForTabSwitchIdle();
    } catch (error) {
      drainErrors.push(error);
    }
    this.#reconcileShutdownSnapshotOwner();
    const results = await Promise.all(
      this.getAllTabs().map(tab => drainTabForShutdownSnapshot(tab)),
    );
    drainErrors.push(...results.flatMap(result => (
      result.cleanupFailures.map(failure => failure.error)
    )));
    throwCollectedErrors(drainErrors, 'Failed to drain every tab for shutdown persistence');
  }

  async #drainInFlightCloseOperations(): Promise<unknown[]> {
    const closeErrors: unknown[] = [];
    while (this.inFlightCloseOperations.size > 0) {
      const results = await Promise.allSettled([...this.inFlightCloseOperations]);
      for (const result of results) {
        if (result.status === 'rejected') closeErrors.push(result.reason);
      }
    }
    return closeErrors;
  }

  #reconcileShutdownSnapshotOwner(): void {
    if (this.activeTabId === null) return;

    const activeTab = this.activeTabId ? this.getTab(this.activeTabId) ?? null : null;
    if (activeTab && activeTab.lifecycleState !== 'closing') {
      if (this.committedTabIds.has(activeTab.id)) {
        this.committedActiveTabId = activeTab.id;
      }
      return;
    }

    const replacement = this.getAllTabs()
      .find(tab => tab.lifecycleState !== 'closing') ?? null;
    this.activeTabId = replacement?.id ?? null;
    this.committedActiveTabId = replacement && this.committedTabIds.has(replacement.id)
      ? replacement.id
      : null;
  }

  /** Destroys all tabs and cleans up resources. */
  async destroy(): Promise<void> {
    if (!this.destructionPromise) {
      this.destructionPromise = this.#destroyOnce();
    }
    await this.destructionPromise;
  }

  async #destroyOnce(): Promise<void> {
    this.beginShutdown();
    this.sealShutdownSnapshot();
    const destroyErrors: unknown[] = [];
    destroyErrors.push(...await this.#drainInFlightCloseOperations());
    try {
      await this.navigation.invalidateAndDrain();
    } catch (error) {
      destroyErrors.push(error);
    }
    try {
      await this.waitForTabSwitchIdle();
    } catch (error) {
      destroyErrors.push(error);
    }
    try {
      await this.navigation.awaitPreviewCleanup();
    } catch (error) {
      destroyErrors.push(error);
    }
    const tabs = this.getAllTabs();
    const metadataTabIds = new Set<TabId>([
      ...tabs.map(tab => tab.id),
      ...this.commandDiscovery.getTrackedTabIds(),
      ...this.tabActivationRevisions.keys(),
    ]);
    for (const tabId of metadataTabIds) {
      destroyErrors.push(...this.#releaseTabRuntimeMetadata(tabId));
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
      ...this.commandDiscovery.getTrackedTabIds(),
      ...this.tabActivationRevisions.keys(),
    ]);
    for (const tabId of finalMetadataTabIds) {
      destroyErrors.push(...this.#releaseTabRuntimeMetadata(tabId));
    }
    this.tabs.clear();
    this.committedTabIds.clear();
    this.commandDiscovery.clear();
    this.tabActivationRevisions.clear();
    this.closingTabIds.clear();
    this.activeTabId = null;
    this.committedActiveTabId = null;

    throwCollectedErrors(destroyErrors, 'Failed to destroy every tab cleanly');
  }
}
