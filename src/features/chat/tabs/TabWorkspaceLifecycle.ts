import type { AppTabManagerState } from '@/core/bootstrap/tabManagerState';
import {
  decodeTabWorkspaceViewState,
  resolveTabRestorePlan,
  TAB_WORKSPACE_VIEW_STATE_KEY,
  TAB_WORKSPACE_VIEW_STATE_VERSION,
  type TabWorkspaceViewState,
} from '@/core/bootstrap/tabManagerState';

import type {
  ChatFeatureHost,
  ChatViewHost,
  TabWorkspaceStateDeliveryRegistration,
} from '../ChatFeatureHost';
import { TabStatePersistenceCoordinator } from '../services/TabStatePersistenceCoordinator';
import type { TabBar } from './TabBar';
import type { TabManager } from './TabManager';

/** The tab manager operations the workspace lifecycle restores, snapshots, and seals. */
export type TabWorkspaceTabManager = Pick<
  TabManager,
  'getPersistedState' | 'restoreState' | 'beginShutdown' | 'drainForShutdownSnapshot' | 'sealShutdownSnapshot'
>;

type TabWorkspaceTitleState = Pick<TabBar, 'getExpandedTitleTabIds'>;
type TabWorkspacePersistence = Pick<TabStatePersistenceCoordinator, 'update' | 'flush'>;

export interface TabWorkspaceLifecycleHost {
  getPlugin(): Pick<
    ChatFeatureHost,
    | 'app'
    | 'settings'
    | 'registerTabWorkspaceStateDelivery'
    | 'claimLegacyTabManagerState'
    | 'completeLegacyTabManagerStateMigration'
    | 'ensureConversationMetadataLoaded'
  >;
  readonly view: ChatViewHost;
  getTabManager(): TabWorkspaceTabManager | null;
  getTabBar(): Pick<TabBar, 'getExpandedTitleTabIds' | 'setExpandedTitleTabIds'> | null;
  /** Restore keeps only the last active tab in the wide session layout. */
  isWideLayout(): boolean;
  /** Publishes presentation once the restored workspace owns the view lifecycle. */
  onInitialized(): void;
}

/** One open lifecycle of the view, from `beginOpen` until the next open or close. */
export interface TabWorkspaceOpening {
  readonly revision: number;
  /** Same-instance reopen: restore from the finalized shutdown snapshot, not delivered state. */
  readonly isReopening: boolean;
  readonly closingSnapshot: Promise<void> | null;
}

/**
 * Owns a chat view's tab workspace across open and close: Obsidian-delivered view state, the
 * restore plan, view-scoped persistence, and the drained shutdown snapshot that a same-instance
 * reopen restores from. While restoration is pending, its full plan stays the persistence
 * authority; once shells are admitted, live membership owns the lifecycle.
 */
export class TabWorkspaceLifecycle {
  private persistence: TabStatePersistenceCoordinator | null = null;
  private hasViewScopedState = false;
  private deliveryRevision = 0;
  private pendingState: AppTabManagerState | null = null;
  private finalizedState: AppTabManagerState | null = null;
  private delivery: TabWorkspaceStateDeliveryRegistration | null = null;
  private initializedRevision = -1;
  private admittedRevision = -1;
  private initialization: { revision: number; promise: Promise<void> } | null = null;
  private shutdownSnapshotPromise: Promise<void> | null = null;
  private lifecycleRevision = 0;
  private shutdownStarted = false;

  constructor(private readonly host: TabWorkspaceLifecycleHost) {}

  /** The current persistence coordinator, shared by a reopen that interrupted a close. */
  get currentPersistence(): TabStatePersistenceCoordinator | null {
    return this.persistence;
  }

  getState(): Record<string, unknown> {
    const state = this.pendingState
      ?? this.capture(this.host.getTabManager())
      ?? this.finalizedState;
    if (!state) return {};

    const tabWorkspace: TabWorkspaceViewState = {
      version: TAB_WORKSPACE_VIEW_STATE_VERSION,
      ...state,
    };
    return { [TAB_WORKSPACE_VIEW_STATE_KEY]: tabWorkspace };
  }

  async setState(state: unknown): Promise<void> {
    const record = state && typeof state === 'object' && !Array.isArray(state)
      ? state as Record<string, unknown>
      : null;
    const hasViewScopedState = record !== null && TAB_WORKSPACE_VIEW_STATE_KEY in record;
    this.hasViewScopedState = hasViewScopedState;
    const registration = this.host.getPlugin().registerTabWorkspaceStateDelivery(
      this.host.view,
      hasViewScopedState,
    );
    this.delivery = registration;
    const revision = this.lifecycleRevision;

    // Once shells are admitted, live membership owns this view lifecycle.
    if (this.initializedRevision === revision || this.admittedRevision === revision) return;

    this.deliveryRevision += 1;
    this.pendingState = hasViewScopedState && record
      ? decodeTabWorkspaceViewState(record[TAB_WORKSPACE_VIEW_STATE_KEY])
      : null;

    if (registration.declarationsReady) {
      await this.initialize(revision);
      return;
    }
    void registration.waitUntilDeclarationsReady
      .then(() => this.initialize(revision))
      .catch(() => undefined);
  }

  /** Starts an open lifecycle; a reopen during close keeps the finalized snapshot. */
  beginOpen(): TabWorkspaceOpening {
    const isReopening = this.shutdownStarted;
    const closingSnapshot = isReopening ? this.shutdownSnapshotPromise : null;
    this.shutdownStarted = false;
    if (!isReopening) this.finalizedState = null;
    this.lifecycleRevision += 1;
    return { revision: this.lifecycleRevision, isReopening, closingSnapshot };
  }

  /**
   * Creates or reuses view-scoped persistence, waiting for an interrupted close to finish its
   * snapshot and flush. Null when a newer lifecycle superseded this open.
   */
  async preparePersistence(opening: TabWorkspaceOpening): Promise<TabStatePersistenceCoordinator | null> {
    let persistence = this.persistence;
    if (!opening.isReopening || !persistence) {
      if (!opening.isReopening) persistence?.dispose();
      persistence = new TabStatePersistenceCoordinator(async () => {
        const { workspace } = this.host.getPlugin().app;
        workspace.requestSaveLayout();
        const save = workspace.requestSaveLayout.run();
        if (save) await save;
      });
    }
    this.persistence = persistence;
    try {
      if (opening.closingSnapshot) await opening.closingSnapshot;
      await persistence.flush();
    } catch {
      // Persistence failures are reported at the storage boundary; reopening must continue.
    }
    if (!this.isCurrent(opening.revision) || this.persistence !== persistence) return null;
    return persistence;
  }

  /** Restores from the finalized snapshot on reopen, otherwise from Obsidian's delivered state. */
  async completeOpen(opening: TabWorkspaceOpening): Promise<void> {
    const reopeningState = opening.isReopening ? this.finalizedState : null;
    if (reopeningState) {
      await this.initialize(opening.revision, reopeningState);
      return;
    }

    const delivery = this.delivery;
    if (!delivery) return;
    if (delivery.declarationsReady) {
      await this.initialize(opening.revision);
      return;
    }
    void delivery.waitUntilDeclarationsReady
      .then(() => this.initialize(opening.revision))
      .catch(() => undefined);
  }

  isCurrent(revision: number): boolean {
    return !this.shutdownStarted && this.lifecycleRevision === revision;
  }

  isInitialized(revision: number): boolean {
    return this.initializedRevision === revision;
  }

  /** True once the current open lifecycle has restored its workspace. */
  get isReady(): boolean {
    return !this.shutdownStarted && this.initializedRevision === this.lifecycleRevision;
  }

  /** Records live membership, unless the pending restore plan is still the authority. */
  persist(
    tabManager: Pick<TabManager, 'getPersistedState'> | null = this.host.getTabManager(),
    persistence: Pick<TabStatePersistenceCoordinator, 'update'> | null = this.persistence,
  ): void {
    if (!persistence || this.pendingState) return;
    const state = this.capture(tabManager);
    if (!state) return;
    persistence.update(state);
  }

  /** Starts a close lifecycle and returns its revision. */
  beginClose(): number {
    this.shutdownStarted = true;
    this.lifecycleRevision += 1;
    return this.lifecycleRevision;
  }

  /** Drains admitted work, flushes the final identity, and seals it; shared by every shutdown path. */
  snapshotForShutdown(
    tabManager: TabWorkspaceTabManager | null,
    persistence: TabWorkspacePersistence | null,
    tabBar: TabWorkspaceTitleState | null = this.host.getTabBar(),
  ): Promise<void> {
    if (this.shutdownSnapshotPromise) return this.shutdownSnapshotPromise;
    const snapshot = this.captureShutdownSnapshot(tabManager, persistence, tabBar);
    this.shutdownSnapshotPromise = snapshot;
    return snapshot;
  }

  /** Disposes persistence after its close, unless a newer open lifecycle retained it. */
  releaseClosedPersistence(
    closeRevision: number,
    persistence: Pick<TabStatePersistenceCoordinator, 'dispose'> | null,
  ): void {
    if (!this.shutdownStarted || this.lifecycleRevision !== closeRevision) return;
    persistence?.dispose();
    if (this.persistence === persistence) this.persistence = null;
  }

  /** Lets the next close take a fresh snapshot once this one has been consumed. */
  settleShutdownSnapshot(snapshot: Promise<void>): void {
    if (this.shutdownSnapshotPromise === snapshot) this.shutdownSnapshotPromise = null;
  }

  async prepareForPluginUnload(): Promise<void> {
    const tabManager = this.host.getTabManager();
    tabManager?.beginShutdown();
    await this.snapshotForShutdown(tabManager, this.persistence);
  }

  private async captureShutdownSnapshot(
    tabManager: TabWorkspaceTabManager | null,
    persistence: TabWorkspacePersistence | null,
    tabBar: TabWorkspaceTitleState | null,
  ): Promise<void> {
    try {
      await tabManager?.drainForShutdownSnapshot();
    } catch {
      // Teardown reports drain failures; identity persistence must still be attempted.
    }
    try {
      await this.flush(tabManager, persistence);
    } catch {
      // The storage boundary reports persistence failures. Teardown must still complete.
    } finally {
      this.finalizedState = this.pendingState ?? this.capture(tabManager, tabBar);
      tabManager?.sealShutdownSnapshot();
    }
  }

  private async initialize(revision: number, reopeningState?: AppTabManagerState): Promise<void> {
    if (
      !this.isCurrent(revision)
      || !this.host.getTabManager()
      || this.initializedRevision === revision
    ) return;

    const current = this.initialization;
    if (current?.revision === revision) {
      await current.promise;
      return;
    }

    const promise = (async () => {
      let deliveryRevision: number;
      do {
        deliveryRevision = this.deliveryRevision;
        await this.restore(revision, reopeningState);
        if (!this.isCurrent(revision)) return;
      } while (deliveryRevision !== this.deliveryRevision);

      this.initializedRevision = revision;
      this.host.onInitialized();
    })();
    this.initialization = { revision, promise };

    try {
      await promise;
    } finally {
      if (this.initialization?.promise === promise) this.initialization = null;
    }
  }

  private async restore(revision: number, reopeningState?: AppTabManagerState): Promise<void> {
    const tabManager = this.host.getTabManager();
    if (!tabManager) return;

    const deliveryRevision = this.deliveryRevision;
    const isStillCurrent = (): boolean => (
      this.isCurrent(revision)
      && this.host.getTabManager() === tabManager
      && deliveryRevision === this.deliveryRevision
    );
    let usedLegacyState = false;
    let persistedState = reopeningState ?? (this.hasViewScopedState ? this.pendingState : null);
    if (reopeningState === undefined && !this.hasViewScopedState) {
      persistedState = await this.host.getPlugin().claimLegacyTabManagerState();
      usedLegacyState = persistedState !== null;
    }
    if (!isStillCurrent()) return;

    const restorePlan = resolveTabRestorePlan(persistedState, {
      restoreTabsOnStartup: reopeningState === undefined
        ? this.host.getPlugin().settings.restoreTabsOnStartup
        : true,
      isDualPane: this.host.isWideLayout(),
    });
    this.pendingState = restorePlan;
    const conversationIds = Array.from(new Set(
      restorePlan.openTabs
        .map(({ conversationId }) => conversationId)
        .filter((id): id is string => id !== null),
    ));
    if (conversationIds.length > 0) {
      await this.host.getPlugin().ensureConversationMetadataLoaded(conversationIds);
    }
    if (!isStillCurrent()) return;

    // restoreState admits the complete shell set synchronously before activation awaits.
    // From this handoff onward live membership, not later Obsidian deliveries, owns it.
    this.admittedRevision = revision;
    try {
      await tabManager.restoreState(restorePlan);
    } catch (error) {
      if (this.isCurrent(revision)) this.admittedRevision = -1;
      throw error;
    }
    if (!isStillCurrent()) return;

    this.host.getTabBar()?.setExpandedTitleTabIds(restorePlan.expandedTitleTabIds ?? []);
    this.pendingState = null;

    if (usedLegacyState) {
      try {
        await this.flush(tabManager, this.persistence);
        await this.host.getPlugin().completeLegacyTabManagerStateMigration();
      } catch {
        // Keep the legacy snapshot available when view-state persistence fails.
      }
    } else {
      this.persist(tabManager, this.persistence);
    }
  }

  private capture(
    tabManager: Pick<TabManager, 'getPersistedState'> | null,
    tabBar: TabWorkspaceTitleState | null = this.host.getTabBar(),
  ): AppTabManagerState | null {
    const state = tabManager?.getPersistedState();
    if (!state) return null;
    if (state.openTabs.length > 0 && state.activeTabId === null) return null;

    const openTabIds = new Set(state.openTabs.map(tab => tab.tabId));
    const expandedTitleTabIds = (tabBar?.getExpandedTitleTabIds() ?? [])
      .filter(tabId => openTabIds.has(tabId));
    return {
      ...state,
      ...(expandedTitleTabIds.length > 0 ? { expandedTitleTabIds } : {}),
    };
  }

  /** Flushes the open working set, or the pending restore plan while it is the authority. */
  private async flush(
    tabManager: Pick<TabManager, 'getPersistedState'> | null,
    persistence: TabWorkspacePersistence | null,
  ): Promise<void> {
    if (!persistence) return;
    const state = this.pendingState ?? this.capture(tabManager);
    if (!state) return;
    persistence.update(state);
    await persistence.flush();
  }
}
