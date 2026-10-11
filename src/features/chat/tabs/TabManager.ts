import { type AppTabManagerState, normalizeTabLabel } from '@/core/bootstrap/tabManagerState';
import type { ProviderId } from '@/core/providers/types';
import type { ChatFeatureHost } from '@/features/chat/ChatFeatureHost';
import type { TabBarItem, TabId, TabManagerInterface, TabManagerViewHost } from '@/features/chat/tabs/ChatTab';
import type { ForkTargetHost } from '@/features/chat/tabs/forking/ForkTarget';
import { TabActivation } from '@/features/chat/tabs/TabActivation';
import { TabClosePolicy, throwCollectedErrors } from '@/features/chat/tabs/TabClosePolicy';
import { TabCommandDiscovery } from '@/features/chat/tabs/TabCommandDiscovery';
import {
  type OpenConversationOptions,
  TabConversationNavigation,
} from '@/features/chat/tabs/TabConversationNavigation';
import {
  createTabIdentity,
  generateTabId,
  resolveBlankTabReselection,
  type TabIdentity,
} from '@/features/chat/tabs/TabIdentity';
import {
  commitProvisionalTab,
  destroyTab,
  drainTabForShutdownSnapshot,
  getTabTitle,
} from '@/features/chat/tabs/TabLifecycle';
import { TabMembership } from '@/features/chat/tabs/TabMembership';
import { onProviderAvailabilityChanged } from '@/features/chat/tabs/tabProviderLifecycle';
import { TabProviderPresence } from '@/features/chat/tabs/TabProviderPresence';
import { createTabRuntimeCallbacks, type TabRuntimeCallbackHost } from '@/features/chat/tabs/TabRuntimeCallbacks';
import { createTabRuntime } from '@/features/chat/tabs/TabRuntimeFactory';
import type {
  AssembledTabRuntime,
  TabLayoutPolicy,
  TabManagerCallbacks,
} from '@/features/chat/tabs/types';
import { ViewerSlot } from '@/features/chat/tabs/ViewerSlot';
import type { VaultMentionDataProvider } from '@/shared/mention/VaultMentionDataProvider';

type CreateTabOptions = {
  activate?: boolean;
  draftModel?: string;
  providerId?: ProviderId | null;
};

type AdmissionOptions = CreateTabOptions & {
  lifecycleState?: Extract<AssembledTabRuntime['lifecycleState'], 'provisional' | 'open'>;
};

/** The compact default: tab commands keep their in-tab behavior and previews are never pinned. */
const DEFAULT_LAYOUT_POLICY: TabLayoutPolicy = {
  forkTarget: () => 'ask',
  openPicked: () => Promise.resolve(false),
  startNew: () => Promise.resolve(false),
  shouldRetainPreview: () => false,
};

/**
 * TabManager orchestrates tab admission, restoration, and shutdown. Per-tab state lives in
 * `membership`; activation, close policy, and runtime event translation have their own owners.
 */
export class TabManager implements TabManagerInterface {
  private plugin: ChatFeatureHost;
  private containerEl: HTMLElement;
  private view: TabManagerViewHost;

  /** The single owner of per-tab state; collaborators read it as a `TabMembershipView`. */
  private readonly membership = new TabMembership();
  private callbacks: TabManagerCallbacks;
  private readonly commandDiscovery: TabCommandDiscovery;
  private readonly providerPresence: TabProviderPresence;
  private readonly activation: TabActivation;
  private readonly navigation: TabConversationNavigation;
  private readonly closePolicy: TabClosePolicy;
  private readonly runtimeCallbackHost: TabRuntimeCallbackHost;
  /** The view's single replaceable preview; the only creator of provisional tabs. */
  readonly viewerSlot: ViewerSlot;
  private destructionPromise: Promise<void> | null = null;
  private shutdownDrainPromise: Promise<void> | null = null;
  private shutdownSnapshotOpen = false;

  constructor(
    plugin: ChatFeatureHost,
    containerEl: HTMLElement,
    view: TabManagerViewHost,
    callbacks: TabManagerCallbacks,
    private readonly mentionDataProvider: VaultMentionDataProvider,
    layoutPolicy: TabLayoutPolicy = DEFAULT_LAYOUT_POLICY,
  ) {
    this.plugin = plugin;
    this.containerEl = containerEl;
    this.view = view;
    this.callbacks = callbacks;
    const { membership } = this;
    this.commandDiscovery = new TabCommandDiscovery(plugin, membership);
    const forkTargetHost: ForkTargetHost = {
      plugin,
      membership,
      createTab: conversationId => this.createTab(conversationId),
      discardTab: tabId => this.discardTab(tabId),
      forkTarget: () => layoutPolicy.forkTarget(),
    };
    this.providerPresence = new TabProviderPresence(
      plugin,
      membership,
      providerId => membership.hasAdmittedProvider(providerId),
    );
    this.activation = new TabActivation({
      membership,
      callbacks,
      assembleRestored: identity => this.#assembleRestoredTab(identity),
      ensureWorkspaceServices: (tab, providerId, reason) => (
        this.providerPresence.ensureWorkspaceServices(tab, providerId, reason)
      ),
    });
    this.navigation = new TabConversationNavigation({
      plugin,
      view,
      membership,
      switchToTab: tabId => this.switchToTab(tabId),
      createTab: (conversationId, activate) => this.createTab(conversationId, undefined, { activate }),
      discardTab: tabId => this.discardTab(tabId),
      canCreateTab: () => this.canCreateTab(),
    });
    this.closePolicy = new TabClosePolicy({
      membership,
      switchToTab: tabId => this.switchToTab(tabId),
      createReplacement: () => this.createTab(null, undefined, { activate: false }),
      releaseMetadata: tabId => this.commandDiscovery.releaseTab(tabId),
      onTabClosed: tabId => this.callbacks.onTabClosed?.(tabId),
    });
    this.runtimeCallbackHost = {
      membership,
      callbacks,
      commandDiscovery: this.commandDiscovery,
      providerPresence: this.providerPresence,
      navigation: this.navigation,
      layoutPolicy,
      forkTargetHost,
      isShutdownSnapshotOpen: () => this.shutdownSnapshotOpen,
    };
    this.viewerSlot = new ViewerSlot({
      app: plugin.app,
      membership,
      navigation: this.navigation,
      createPreview: conversationId => this.#createTab(conversationId, undefined, {
        lifecycleState: 'provisional',
      }),
      switchToTab: tabId => this.switchToTab(tabId),
      closeTab: tabId => this.closeTab(tabId),
      discardTab: tabId => this.discardTab(tabId),
      shouldRetain: conversationId => layoutPolicy.shouldRetainPreview(conversationId),
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
    return this.#createTab(conversationId, tabId, options);
  }

  async #createTab(
    conversationId: string | null | undefined,
    tabId: TabId | undefined,
    options: AdmissionOptions,
  ): Promise<AssembledTabRuntime | null> {
    if (this.membership.isDestroyed()) return null;

    const runtimeTabId = tabId ?? generateTabId();
    if (this.membership.holds(runtimeTabId)) {
      throw new Error(`Tab ID is already owned or reserved: ${runtimeTabId}`);
    }

    this.membership.reserve(runtimeTabId);
    const activationRequestRevision = options.activate !== false
      ? this.activation.reserveIntent(runtimeTabId)
      : null;
    try {
      return await this.#assembleReservedTab(
        conversationId,
        runtimeTabId,
        options,
        activationRequestRevision,
      );
    } finally {
      this.membership.endReservation(runtimeTabId);
    }
  }

  /** Assembles a runtime on a reserved ID: a new tab, or a restored identity being assembled. */
  async #assembleReservedTab(
    conversationId: string | null | undefined,
    runtimeTabId: TabId,
    options: AdmissionOptions,
    activationRequestRevision: number | null,
    restoredIdentity?: TabIdentity,
  ): Promise<AssembledTabRuntime | null> {
    const { membership } = this;
    if (membership.isDestroyed()) return null;

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
        ...createTabRuntimeCallbacks(this.runtimeCallbackHost, () => tab),
      });

      if (tab.id !== runtimeTabId) {
        throw new Error(
          `Tab runtime ID ${tab.id} does not match reserved ID ${runtimeTabId}`,
        );
      }

      if (membership.isDestroyed() || (restoredIdentity && (
        !membership.isTabAlive(restoredIdentity)
        || restoredIdentity.conversationId !== tab.conversationId
        || restoredIdentity.draftModel !== tab.draftModel
        || restoredIdentity.providerId !== tab.providerId
      ))) {
        const abandonedTab = tab;
        tab = null;
        throwCollectedErrors(
          await this.#discardUnpublished(abandonedTab, runtimeTabId),
          'Failed to roll back a tab assembled after manager destruction',
        );
        return null;
      }

      // A rename while the restored tab assembled lands on its identity, not the runtime's copy.
      if (restoredIdentity) tab.session.setLabel(restoredIdentity.label ?? null);
      this.commandDiscovery.registerTab(tab.id);
    } catch (error) {
      const rollbackErrors = await this.#discardUnpublished(tab, runtimeTabId);
      if (rollbackErrors.length > 0) {
        throw new AggregateError(
          [error, ...rollbackErrors],
          'Tab runtime setup failed and rollback also encountered errors',
          { cause: error },
        );
      }
      throw error;
    }

    let rollbackActiveTabId = membership.getActiveTabId();
    membership.install(tab);
    try {
      if (activate) {
        await this.activation.activateAdmitted(tab.id, activationRequestRevision, previousTabId => {
          rollbackActiveTabId = previousTabId;
        });
      }

      if (!membership.isTabAlive(tab)) return null;
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

    membership.admit(tab.id);
    this.providerPresence.startForTab(tab);
    if (membership.getActiveTabId() === tab.id) membership.recordCommittedActivation(tab.id);

    try {
      this.callbacks.onTabCreated?.(tab);
    } catch {
      // Admission is committed; an observer failure must not retract published membership.
    }
    return tab;
  }

  /** Destroys a runtime that never joined membership and releases its metadata; returns failures. */
  async #discardUnpublished(tab: AssembledTabRuntime | null, tabId: TabId): Promise<unknown[]> {
    const errors: unknown[] = [];
    try {
      if (tab) await destroyTab(tab);
    } catch (error) {
      errors.push(error);
    }
    errors.push(...this.commandDiscovery.releaseTab(tabId));
    return errors;
  }

  async #rollbackAdmittedTab(
    tab: AssembledTabRuntime,
    previousActiveTabId: TabId | null,
  ): Promise<unknown[]> {
    const { membership } = this;
    const rollbackErrors: unknown[] = [];
    if (membership.getTab(tab.id) !== tab) {
      rollbackErrors.push(...this.commandDiscovery.releaseTab(tab.id));
      return rollbackErrors;
    }

    membership.beginClose(tab.id);
    rollbackErrors.push(...this.commandDiscovery.releaseTab(tab.id));
    rollbackErrors.push(...this.activation.rollbackAdmission(tab, previousActiveTabId));

    membership.remove(tab.id);
    try {
      await destroyTab(tab);
    } catch (error) {
      rollbackErrors.push(error);
    }
    return rollbackErrors;
  }

  /** Assembles a restored tab's runtime on its ID, holding the ID until assembly settles. */
  async #assembleRestoredTab(identity: TabIdentity): Promise<AssembledTabRuntime | null> {
    this.membership.reserve(identity.id);
    try {
      return await this.#assembleReservedTab(identity.conversationId, identity.id, {
        activate: false, draftModel: identity.draftModel ?? undefined, providerId: identity.providerId,
      }, null, identity);
    } finally {
      this.membership.endReservation(identity.id);
    }
  }

  /**
   * Switches to a different tab.
   * @param tabId The tab to switch to.
   */
  async switchToTab(tabId: TabId): Promise<void> {
    await this.activation.switchTo(tabId);
  }

  getTabSwitchRequestRevision(): number {
    return this.activation.requestRevision;
  }

  async waitForTabSwitchIdle(): Promise<void> {
    await this.activation.waitForIdle();
  }

  /**
   * Closes a tab.
   * @param tabId The tab to close.
   * @param force If true, close even if streaming.
   * @returns True if the tab was closed.
   */
  async closeTab(tabId: TabId, force = false): Promise<boolean> {
    return this.closePolicy.close(tabId, force);
  }

  /**
   * Discards a manager-owned tab even when it is the last blank draft.
   * A fresh draft is installed when needed to preserve the live-manager invariant.
   */
  async discardTab(tabId: TabId): Promise<boolean> {
    return this.closePolicy.discard(tabId);
  }

  // ============================================
  // Tab Queries
  // ============================================

  /** Gets the currently active tab. */
  getActiveTab(): AssembledTabRuntime | null {
    const activeTabId = this.membership.getActiveTabId();
    return activeTabId ? this.membership.getTab(activeTabId) : null;
  }

  /** Gets the active tab ID. */
  getActiveTabId(): TabId | null {
    return this.membership.getActiveTabId();
  }

  /** Gets a tab by ID. */
  getTab(tabId: TabId): AssembledTabRuntime | null {
    return this.membership.getTab(tabId);
  }

  /** Gets assembled runtimes; inactive restored identities are available separately. */
  getAllTabs(): AssembledTabRuntime[] {
    return this.membership.getAllTabs();
  }

  /** Ordered membership for navigation and persistence, including unassembled restored tabs. */
  getTabIdentities(): readonly Readonly<TabIdentity>[] {
    return this.membership.getTabIdentities();
  }

  /** True while the tab has any user-visible foreground or background work in progress. */
  isTabWorking(tabId: TabId): boolean {
    return this.getTab(tabId)?.session.isWorking ?? false;
  }

  /** Reconciles blank drafts after provider/model availability changes; inert once shutdown begins. */
  reconcileProviderAvailability(): void {
    const { membership } = this;
    if (membership.isDestroyed()) return;
    for (const identity of membership.getTabIdentities()) {
      if (identity.lifecycleState === 'closing') continue;
      const runtime = membership.getTab(identity.id);
      let changed: boolean;
      if (runtime) {
        changed = onProviderAvailabilityChanged(runtime, this.plugin);
      } else {
        const selection = resolveBlankTabReselection(identity, this.plugin);
        if (selection) membership.selectDraft(identity.id, selection);
        changed = selection !== null;
      }
      if (changed) {
        this.callbacks.onTabDraftChanged?.(identity.id, identity.draftModel);
        this.callbacks.onTabProviderChanged?.(identity.id, identity.providerId);
      }
      this.providerPresence.startForTab(identity);
    }
  }

  async resetConversationTabs(conversationId: string): Promise<void> {
    const { membership } = this;
    const errors: unknown[] = [];
    for (const identity of membership.getTabIdentities()) {
      if (identity.conversationId !== conversationId || !membership.isTabStateMutable(identity)) continue;
      const runtime = membership.getTab(identity.id);
      try {
        if (runtime) {
          runtime.controllers.inputController.cancelStreaming();
          await runtime.controllers.conversationController.createNew({ force: true });
        } else {
          const blank = createTabIdentity(this.plugin.settings, null, {
            tabId: identity.id,
            ...(identity.label ? { label: identity.label } : {}),
          });
          membership.replaceRestored(blank);
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
    return this.membership.size;
  }

  /**
   * Captures every retained tab identity without runtime lifecycle state. Provisional previews
   * are never persisted; while one is active, the last active retained tab is saved.
   */
  getPersistedState(): AppTabManagerState {
    return this.membership.getPersistedState();
  }

  /** Restores tab identities without provider execution, then activates exactly one final target. */
  async restoreState(state: AppTabManagerState): Promise<void> {
    const { membership } = this;
    for (const tabState of state.openTabs) {
      if (
        tabState.conversationId
        && !this.plugin.getCachedConversation(tabState.conversationId)
      ) {
        continue;
      }
      if (membership.isDestroyed()) return;
      if (membership.holds(tabState.tabId)) continue;
      const identity = createTabIdentity(this.plugin.settings,
        tabState.conversationId ? this.plugin.getCachedConversation(tabState.conversationId) : null,
        { ...tabState, lifecycleState: 'open' });
      membership.addRestored(identity);
      this.providerPresence.startForTab(identity);
    }

    const memberIds = membership.getTabIdentities().map(identity => identity.id);
    const targetIds = new Set([
      ...(state.activeTabId && memberIds.includes(state.activeTabId) ? [state.activeTabId] : []),
      ...memberIds,
    ]);
    for (const targetId of targetIds) {
      if (membership.isDestroyed()) return;
      try {
        await this.switchToTab(targetId);
        if (this.getActiveTab()) return;
      } catch (error) {
        // Keep failed restored tabs retryable and continue restoring a usable workspace.
        // Once assembly succeeded, preserve the normal activation rollback/error contract.
        if (this.getTab(targetId)) throw error;
      }
    }

    await this.createTab();
  }

  /** Checks if more tabs can be created. */
  canCreateTab(): boolean {
    return !this.membership.isDestroyed();
  }

  /**
   * Records explicit user retention: claims ownership of each live runtime and commits it
   * when it is still a provisional preview. Unknown, unassembled, and closing IDs are ignored.
   */
  retainTabs(tabIds: readonly TabId[]): void {
    for (const tabId of tabIds) {
      const tab = this.getTab(tabId);
      if (!tab || !this.membership.isTabAlive(tab)) continue;
      commitProvisionalTab(tab);
    }
  }

  /** Owned, without an admitted close, and the manager is live: the tab may receive new work. */
  isTabLive(tabId: TabId): boolean {
    const identity = this.membership.getIdentity(tabId);
    return !!identity && this.membership.isTabAlive(identity);
  }

  /**
   * Sets or clears (null) the user's name for a tab; it stays with the tab, not its conversation.
   * Naming is user ownership, so a named preview is retained and its label persists.
   */
  setTabLabel(tabId: TabId, label: string | null): void {
    if (!this.isTabLive(tabId)) return;
    const normalized = label === null ? null : normalizeTabLabel(label);
    const runtime = this.getTab(tabId);
    if (runtime && normalized !== null) commitProvisionalTab(runtime);
    if (!this.membership.setLabel(tabId, normalized)) return;
    try {
      this.callbacks.onTabLabelChanged?.(tabId, normalized);
    } catch {
      // The label is committed; an observer failure must not roll it back.
    }
  }

  // ============================================
  // Tab Bar Data
  // ============================================

  /** Gets data for rendering the tab bar. */
  getTabBarItems(): TabBarItem[] {
    const identities = this.membership.getTabIdentities();
    const activeTabId = this.membership.getActiveTabId();
    return identities.map((tab, index) => {
      const runtime = this.getTab(tab.id);
      return {
        id: tab.id,
        index: index + 1,
        title: getTabTitle(tab, this.plugin),
        ...(tab.label ? { label: tab.label } : {}),
        isActive: tab.id === activeTabId,
        isWorking: this.isTabWorking(tab.id),
        attention: runtime?.state.attention ?? null,
        canClose: !runtime?.state.isRewinding && (identities.length > 1 || !runtime?.session.hasActiveTurn),
      };
    });
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

  // ============================================
  // Cleanup
  // ============================================

  /** Synchronously fences new work while preserving state for the shutdown snapshot. */
  beginShutdown(): void {
    if (this.membership.isDestroyed()) return;
    this.membership.markDestroyed();
    this.shutdownSnapshotOpen = true;
    for (const tab of this.getAllTabs()) tab.session.beginShutdown();
  }

  /** Seals the final identity snapshot so late runtime callbacks cannot mutate tab state. */
  sealShutdownSnapshot(): void {
    this.shutdownSnapshotOpen = false;
    this.membership.sealIdentities();
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
    const drainErrors = await this.#joinAdmittedWork();
    this.#reconcileShutdownSnapshotOwner();
    const results = await Promise.all(
      this.getAllTabs().map(tab => drainTabForShutdownSnapshot(tab)),
    );
    drainErrors.push(...results.flatMap(result => (
      result.cleanupFailures.map(failure => failure.error)
    )));
    throwCollectedErrors(drainErrors, 'Failed to drain every tab for shutdown persistence');
  }

  /** Joins admitted closes, navigation, and tab switches; returns their failures. */
  async #joinAdmittedWork(): Promise<unknown[]> {
    const errors = await this.closePolicy.drain();
    try {
      await this.navigation.invalidateAndDrain();
    } catch (error) {
      errors.push(error);
    }
    try {
      await this.waitForTabSwitchIdle();
    } catch (error) {
      errors.push(error);
    }
    return errors;
  }

  #reconcileShutdownSnapshotOwner(): void {
    const { membership } = this;
    const activeTabId = membership.getActiveTabId();
    if (activeTabId === null) return;

    const activeTab = membership.getTab(activeTabId);
    const owner = activeTab && activeTab.lifecycleState !== 'closing'
      ? activeTab
      : this.getAllTabs().find(tab => tab.lifecycleState !== 'closing') ?? null;
    membership.setActiveTabId(owner?.id ?? null);
    if (owner) membership.recordCommittedActivation(owner.id);
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
    const destroyErrors = await this.#joinAdmittedWork();
    try {
      await this.navigation.awaitFence();
    } catch (error) {
      destroyErrors.push(error);
    }
    // Destroyed tabs cannot recreate discovery metadata, so it is released once, before teardown.
    destroyErrors.push(...this.commandDiscovery.releaseAll());

    // Each tab drains background work and persists its final state during teardown.
    const teardownResults = await Promise.allSettled(this.getAllTabs().map(tab => destroyTab(tab)));
    for (const result of teardownResults) {
      if (result.status === 'rejected') destroyErrors.push(result.reason);
    }
    this.membership.clear();

    throwCollectedErrors(destroyErrors, 'Failed to destroy every tab cleanly');
  }
}
