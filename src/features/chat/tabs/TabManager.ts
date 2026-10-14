import { Notice } from 'obsidian';

import { type AppTabManagerState, normalizeTabLabel } from '@/core/bootstrap/tabManagerState';
import type { ProviderId } from '@/core/providers/types';
import type { ChatFeatureHost } from '@/features/chat/ChatFeatureHost';
import type { ChatSessionRuntime } from '@/features/chat/sessions/ChatSessionRuntime';
import { type DraftSessionHold, SessionAlreadyAttached } from '@/features/chat/sessions/SessionRuntimePool';
import type { TabBarItem, TabId, TabManagerInterface, TabManagerViewHost } from '@/features/chat/tabs/ChatTab';
import type { ForkTargetHost } from '@/features/chat/tabs/forking/ForkTarget';
import { ParkedDrafts } from '@/features/chat/tabs/ParkedDrafts';
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
  activateTab,
  commitProvisionalTab,
  deactivateTab,
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
import { revealWorkspaceLeaf } from '@/utils/obsidianCompat';

type CreateTabOptions = {
  activate?: boolean;
  draftModel?: string;
  providerId?: ProviderId | null;
};

type AdmissionOptions = CreateTabOptions & {
  lifecycleState?: Extract<AssembledTabRuntime['lifecycleState'], 'provisional' | 'open'>;
  draftSessionKey?: string;
};

/** In the narrow layout a saved preview of a session that has a narrow tab returns to that tab. */
function returnPreviewToNarrowTab(state: AppTabManagerState): AppTabManagerState {
  const preview = state.openTabs.find(tab => tab.preview);
  const narrowTab = preview?.conversationId
    ? state.openTabs.find(tab => tab !== preview && tab.conversationId === preview.conversationId)
    : undefined;
  if (!narrowTab) return state;
  return { ...state, openTabs: state.openTabs.filter(tab => tab !== preview), activeTabId: narrowTab.tabId };
}

/** The compact default: tab commands keep their in-tab behavior and no viewer slot shows previews. */
const DEFAULT_LAYOUT_POLICY: TabLayoutPolicy = {
  forkTarget: () => 'ask',
  openPicked: () => Promise.resolve(false),
  startNew: () => Promise.resolve(false),
  showsPreviews: () => false,
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
  /** Unsent composer text no presentation shows: wide-layout sessions and unloaded narrow tabs. */
  private readonly parkedDrafts = new ParkedDrafts();
  /** Draft sessions held for unloaded blank tabs, which reattach them by key. */
  private readonly draftHolds = new Map<TabId, DraftSessionHold>();
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
    private readonly layoutPolicy: TabLayoutPolicy = DEFAULT_LAYOUT_POLICY,
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
      showInViewer: async (conversationId, sourceTab, isValid) => {
        await this.viewerSlot.show(conversationId, { sourceTab, isValid });
        return membership.getAllTabs()
          .find(tab => tab.conversationId === conversationId && membership.isTabAlive(tab)) ?? null;
      },
      discardTab: tabId => this.discardTab(tabId),
      forkTarget: () => layoutPolicy.forkTarget(),
      rebind: (tab, id, isCurrent) => this.rebindTab(tab, id, isCurrent),
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
      rebind: (tab, id, isCurrent) => this.rebindTab(tab, id, isCurrent),
    });
    this.closePolicy = new TabClosePolicy({
      membership,
      switchToTab: tabId => this.switchToTab(tabId),
      createReplacement: () => this.createTab(null, undefined, { activate: false }),
      // The wide layout never falls back to a narrow tab: a closed preview gives way to a draft.
      createPreviewReplacement: () => (layoutPolicy.showsPreviews()
        ? this.#createTab(null, undefined, { activate: false, lifecycleState: 'provisional' })
        : Promise.resolve(null)),
      releaseMetadata: tabId => this.commandDiscovery.releaseTab(tabId),
      onTabClosed: tabId => {
        this.#releaseDraftHold(tabId);
        this.callbacks.onTabClosed?.(tabId);
      },
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
      startNew: tab => this.navigation.enqueue(tab, async isCurrent => { await this.rebindTab(tab, null, isCurrent); }),
    };
    this.viewerSlot = new ViewerSlot({
      app: plugin.app,
      membership,
      navigation: this.navigation,
      // A held session keeps its own selection; only a new draft takes the saved one.
      createPreview: (conversationId, draft) => this.#createTab(conversationId, undefined, {
        lifecycleState: 'provisional',
        ...(draft?.draftSessionKey ? { draftSessionKey: draft.draftSessionKey }
          : draft?.draftModel ? { draftModel: draft.draftModel, providerId: draft.providerId ?? null }
            : {}),
      }),
      holdDraft: tab => this.plugin.sessionRuntimes.holdDraft(tab.session.runtime),
      heldDraftKey: tabId => this.draftHolds.get(tabId)?.key ?? null,
      adoptDraft: (tabId, tab) => {
        const identity = membership.getIdentity(tabId);
        if (!identity || membership.getTab(tabId) || identity.conversationId) return;
        this.#holdDraftFor(tabId, this.plugin.sessionRuntimes.holdDraft(tab.session.runtime));
      },
      switchToTab: tabId => this.switchToTab(tabId),
      closeTab: tabId => this.closeTab(tabId),
      discardTab: tabId => this.discardTab(tabId),
      rebind: (tab, id, isCurrent) => this.rebindTab(tab, id, isCurrent, { parkSourceDrafts: true }),
      parkedDrafts: this.parkedDrafts,
      unloadTab: tab => this.#unloadTab(tab),
      handOver: (tabId, successorId) => this.closePolicy.handOver(tabId, successorId),
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
      draftSessionKey,
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
        ...(draftSessionKey ? { draftSessionKey } : {}),
        revealSession: isCurrent => this.revealTab(runtimeTabId, isCurrent),
        ...createTabRuntimeCallbacks(this.runtimeCallbackHost, () => tab),
      });

      if (tab.id !== runtimeTabId) {
        throw new Error(
          `Tab runtime ID ${tab.id} does not match reserved ID ${runtimeTabId}`,
        );
      }

      // A held draft session owns its own selection and may have created its conversation.
      if (membership.isDestroyed() || (restoredIdentity && (
        !membership.isTabAlive(restoredIdentity)
        || (!this.draftHolds.has(restoredIdentity.id) && (
          restoredIdentity.conversationId !== tab.conversationId
          || restoredIdentity.draftModel !== tab.draftModel
          || restoredIdentity.providerId !== tab.providerId
        ))
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
      this.parkedDrafts.restoreInto(tab);
    } catch (error) {
      const rollbackErrors = await this.#discardUnpublished(tab, runtimeTabId);
      if (rollbackErrors.length > 0) {
        throw new AggregateError(
          [error, ...rollbackErrors],
          'Tab runtime setup failed and rollback also encountered errors',
          { cause: error },
        );
      }
      if (error instanceof SessionAlreadyAttached) {
        await error.attachment.owner.reveal();
        return null;
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
      const draftSessionKey = this.draftHolds.get(identity.id)?.key;
      const tab = await this.#assembleReservedTab(identity.conversationId, identity.id, {
        activate: false, draftModel: identity.draftModel ?? undefined, providerId: identity.providerId,
        ...(draftSessionKey ? { draftSessionKey } : {}),
      }, null, identity);
      // Once reattached, the attachment keeps the draft session; the unloaded tab's hold ends.
      if (tab) this.#releaseDraftHold(identity.id);
      return tab;
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

  private async revealTab(tabId: TabId, isCurrent: () => boolean = () => true): Promise<void> {
    const identity = this.membership.getIdentity(tabId);
    await revealWorkspaceLeaf(this.plugin.app.workspace, this.view.leaf);
    if (!isCurrent() || !identity || !this.membership.isTabAlive(identity)) return;
    await this.switchToTab(tabId);
  }

  /** Replaces presentation in place; the prior session stays independently owned by the pool. */
  private async rebindTab(
    source: AssembledTabRuntime,
    conversationId: string | null,
    isCurrent: () => boolean = () => this.membership.isTabAlive(source),
    options: { parkSourceDrafts?: boolean } = {},
  ): Promise<AssembledTabRuntime | null> {
    if (!isCurrent() || !this.membership.isTabStateMutable(source)) return null;
    if (conversationId && source.conversationId === conversationId) return source;
    const conversation = conversationId ? this.plugin.getCachedConversation(conversationId) : null;
    if (conversationId && !conversation) return null;
    const identity = createTabIdentity(this.plugin.settings, conversation, {
      tabId: source.id, lifecycleState: source.lifecycleState === 'provisional' ? 'provisional' : 'open',
      ...(source.label ? { label: source.label } : {}),
    });
    let target: AssembledTabRuntime | null = null;
    try {
      target = await createTabRuntime({
        plugin: this.plugin, containerEl: this.containerEl, component: this.view,
        mentionDataProvider: this.mentionDataProvider, initialState: identity, tabId: source.id,
        conversation: conversation ?? undefined,
        revealSession: isCurrent => this.revealTab(source.id, isCurrent),
        ...createTabRuntimeCallbacks(this.runtimeCallbackHost, () => target),
      });
      await target.session.runtime.model.hydrate();
      if (!isCurrent() || !this.membership.isTabStateMutable(source)) { await destroyTab(target); return null; }
      if (source.lifecycleState === 'open') target.session.commitAdmission();
      if (source.session.isUserClaimed) target.session.claimUserOwnership();
      target.session.setLabel(source.label ?? null);
      // A branch preview's prefilled prompt belongs to the source transcript; restore the user's own draft first.
      source.controllers.conversationController.cancelBranchDraft();
      if (options.parkSourceDrafts) {
        this.parkedDrafts.park(source);
      } else {
        for (const destination of ['main', 'side'] as const) {
          target.controllers.drafts.restore(destination, source.controllers.drafts.capture(destination), { merge: true });
        }
      }
      this.parkedDrafts.restoreInto(target);
      const wasActive = this.membership.getActiveTabId() === source.id;
      if (wasActive) deactivateTab(source);
      this.membership.install(target);
      try {
        this.commandDiscovery.invalidateTab(source.id);
        if (wasActive) await this.activation.activateAdmitted(target.id, null, () => undefined);
      } catch (error) {
        this.membership.install(source);
        if (wasActive) {
          activateTab(source);
          this.callbacks.onActiveTabChanged?.(source.id, source.id);
        }
        throw error;
      }
      // Membership has committed. Cleanup or observer failures cannot retract the new binding.
      try { await destroyTab(source); } catch (error) {
        new Notice(error instanceof Error ? error.message : 'Failed to release the previous tab presentation');
      }
      this.providerPresence.startForTab(target);
      try { this.callbacks.onTabConversationChanged?.(target.id, conversationId); } catch { /* committed */ }
      return target;
    } catch (error) {
      if (target && this.membership.getTab(target.id) !== target) await destroyTab(target);
      if (error instanceof SessionAlreadyAttached) { await error.attachment.owner.reveal(); return null; }
      throw error;
    }
  }

  async waitForTabSwitchIdle(): Promise<void> {
    await this.activation.waitForIdle();
  }

  /**
   * Closes a tab.
   * @param tabId The tab to close.
   * @returns True if the tab was closed.
   */
  async closeTab(tabId: TabId): Promise<boolean> {
    return this.closePolicy.close(tabId);
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
    return this.#sessionOf(tabId)?.isWorking ?? false;
  }

  /**
   * The tab's session: its attached runtime, its held draft, else the pool's session for its
   * saved conversation.
   */
  #sessionOf(tabId: TabId): Pick<ChatSessionRuntime, 'isWorking' | 'statusAttention'> | null {
    const runtime = this.getTab(tabId)?.session.runtime ?? this.draftHolds.get(tabId)?.runtime;
    if (runtime) return runtime;
    const conversationId = this.membership.getIdentity(tabId)?.conversationId;
    return conversationId ? this.plugin.sessionRuntimes.get(conversationId) : null;
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
          await this.rebindTab(runtime, null, () => membership.isTabStateMutable(runtime));
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
  async restoreState(savedState: AppTabManagerState): Promise<void> {
    const { membership } = this;
    const state = this.layoutPolicy.showsPreviews() ? savedState : returnPreviewToNarrowTab(savedState);
    for (const tabState of state.openTabs) {
      if (
        tabState.conversationId
        && !this.plugin.getCachedConversation(tabState.conversationId)
      ) {
        continue;
      }
      if (membership.isDestroyed()) return;
      if (membership.holds(tabState.tabId)) continue;
      if (tabState.conversationId) {
        const owner = this.plugin.findConversationAcrossViews(tabState.conversationId);
        // Restore publishes cold identities synchronously, so concurrent panes see the first owner.
        // Unlike an explicit open, restoring a duplicate must not move focus to that pane.
        if (owner && owner.view.getTabManager() !== this) continue;
      }
      // A draft preview stays replaceable only where a viewer slot can replace it.
      const lifecycleState = tabState.preview && this.layoutPolicy.showsPreviews() ? 'provisional' : 'open';
      const identity = createTabIdentity(this.plugin.settings,
        tabState.conversationId ? this.plugin.getCachedConversation(tabState.conversationId) : null,
        { ...tabState, lifecycleState });
      membership.addRestored(identity);
      this.providerPresence.startForTab(identity);
    }

    // The wide layout never shows narrow tabs: show the saved preview, else the active tab's session.
    if (this.layoutPolicy.showsPreviews()) {
      const selected = state.activeTabId ? membership.getIdentity(state.activeTabId) : null;
      if (selected?.lifecycleState === 'provisional') {
        await this.switchToTab(selected.id);
        if (this.getActiveTab()) return;
      }
      await this.viewerSlot.enter(selected?.lifecycleState === 'open' ? selected : null);
      return;
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

  /** Shows a tab's session the layout's way: the wide viewer for a narrow tab, otherwise the tab. */
  async focusTab(tabId: TabId): Promise<void> {
    const identity = this.membership.getIdentity(tabId);
    if (identity?.conversationId && identity.lifecycleState === 'open' && this.layoutPolicy.showsPreviews()) {
      await this.viewerSlot.show(identity.conversationId);
      return;
    }
    await this.switchToTab(tabId);
  }

  /** Unloads an assembled narrow tab to its identity; its session keeps running unattached. */
  async #unloadTab(tab: AssembledTabRuntime): Promise<void> {
    const { membership } = this;
    if (membership.getTab(tab.id) !== tab || !membership.isTabAlive(tab) || tab.lifecycleState !== 'open') return;
    // A session with a conversation stays reachable by it; a draft is held for this tab.
    const hold = tab.conversationId ? null : this.plugin.sessionRuntimes.holdDraft(tab.session.runtime);
    if (hold) this.#holdDraftFor(tab.id, hold);
    if (membership.getActiveTabId() === tab.id) {
      deactivateTab(tab);
      membership.setActiveTabId(null);
    }
    membership.unload({
      id: tab.id,
      conversationId: tab.conversationId,
      draftModel: tab.draftModel,
      providerId: tab.providerId,
      lifecycleState: 'open',
      ...(tab.label ? { label: tab.label } : {}),
    });
    throwCollectedErrors(this.commandDiscovery.releaseTab(tab.id), `Failed to release tab ${tab.id} metadata`);
    await destroyTab(tab);
  }

  #holdDraftFor(tabId: TabId, hold: DraftSessionHold): void {
    this.draftHolds.get(tabId)?.release();
    this.draftHolds.set(tabId, hold);
  }

  #releaseDraftHold(tabId: TabId): void {
    this.draftHolds.get(tabId)?.release();
    this.draftHolds.delete(tabId);
  }

  /** Binds unloaded blank tabs to the conversation their held draft session has since created. */
  reconcileUnloadedSessions(): void {
    const { membership } = this;
    for (const [tabId, hold] of this.draftHolds) {
      const identity = membership.getIdentity(tabId);
      const conversationId = hold.runtime.conversationId;
      if (!identity || membership.getTab(tabId) || !conversationId || identity.conversationId === conversationId) continue;
      membership.replaceRestored({ ...identity, conversationId, draftModel: null, providerId: hold.runtime.providerId });
      try { this.callbacks.onTabConversationChanged?.(tabId, conversationId); } catch { /* committed */ }
    }
  }

  /** Checks if more tabs can be created. */
  canCreateTab(): boolean {
    return !this.membership.isDestroyed();
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
        attention: this.#sessionOf(tab.id)?.statusAttention ?? null,
        canClose: identities.length > 1 || !!tab.conversationId || !!runtime?.state.messages.length,
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
      await this.runtimeCallbackHost.startNew(activeTab);
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
  }

  /** Seals the final identity snapshot so late runtime callbacks cannot mutate tab state. */
  sealShutdownSnapshot(): void {
    this.shutdownSnapshotOpen = false;
    this.membership.sealIdentities();
  }

  /** Joins navigation and draft promotion before capturing view identity. */
  async drainForShutdownSnapshot(): Promise<void> {
    this.beginShutdown();
    if (!this.shutdownDrainPromise) {
      this.shutdownDrainPromise = this.#drainForShutdownSnapshotOnce();
    }
    await this.shutdownDrainPromise;
  }

  async #drainForShutdownSnapshotOnce(): Promise<void> {
    const drainErrors = await this.#joinAdmittedWork();
    // Unloaded blank tabs follow their held drafts: join conversation creation, then rebind them.
    const settlements = await Promise.allSettled(
      [...this.draftHolds.values()].map(hold => hold.runtime.awaitIdentitySettlement()),
    );
    for (const settlement of settlements) {
      if (settlement.status === 'rejected') drainErrors.push(settlement.reason);
    }
    this.reconcileUnloadedSessions();
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
    for (const tabId of [...this.draftHolds.keys()]) this.#releaseDraftHold(tabId);
    this.viewerSlot.dispose();

    throwCollectedErrors(destroyErrors, 'Failed to destroy every tab cleanly');
  }
}
