import type { ProviderId } from '@/core/providers/types';
import type { ChatExecutionCoordinator } from '@/features/chat/execution/ChatExecutionCoordinator';
import type { SessionMailbox } from '@/features/chat/session-messaging/SessionMailbox';
import type { SessionChange, SessionModel } from '@/features/chat/sessions/SessionModel';
import type { SideChatController } from '@/features/chat/side-chat/SideChatController';
import { SessionAttention } from '@/features/chat/state/SessionAttention';
import { type TurnCancelReason, TurnCoordinator } from '@/features/chat/turns/TurnCoordinator';

export interface SessionIdentity {
  conversationId: string | null;
  providerId: ProviderId | null;
  draftModel: string | null;
  /** A held draft session to reattach, while it has no conversation to be found by. */
  draftSessionKey?: string;
}

let nextSessionKey = 0;

export interface TurnCancelOptions {
  dismissInteractions?: boolean;
  /** Another session's interrupt keeps the pending session messages it is delivered with. */
  keepMailbox?: boolean;
}

export class ChatSessionRuntime {
  /** Stable for the session's lifetime; how a held draft is reattached before it has a conversation. */
  readonly sessionKey = `session-${++nextSessionKey}`;
  readonly attention = new SessionAttention();
  private currentModel: SessionModel | null = null;
  private mailboxOwner: SessionMailbox | null = null;
  private childOwner: SideChatController | null = null;
  private lifetime: 'open' | 'closing' | 'disposed' = 'open';
  private readonly listeners = new Set<() => void>();
  private pendingBackgroundWork = 0;
  private readonly modelWork = new Set<Promise<unknown>>();
  private disposal: Promise<void> | null = null;

  get isDisposed(): boolean { return this.lifetime !== 'open'; }
  get peekModel(): SessionModel | null { return this.currentModel; }
  get model(): SessionModel {
    if (!this.currentModel) {
      if (this.isDisposed) throw new Error('Cannot create a model for a disposed session');
      this.currentModel = this.createModel(this);
    }
    return this.currentModel;
  }

  get statusAttention() {
    const child = this.childOwner?.runtime?.state.attention;
    return child?.kind === 'action-required' ? child : this.attention.attention;
  }

  releaseModel(model: SessionModel): void {
    if (this.currentModel !== model || !model.canEvict || !this.isIdle) return;
    model.dispose();
    this.currentModel = null;
  }

  async ensureModel(): Promise<SessionModel> {
    const model = this.model;
    await model.hydrate();
    return model;
  }

  /** Holds the main model through hydration and the whole unsolicited event callback. */
  async withModel<T>(operation: (model: SessionModel) => Promise<T>): Promise<T> {
    if (this.isDisposed) throw new Error('Session is shutting down');
    const pending = this.ensureModel().then(operation);
    this.modelWork.add(pending);
    try { return await pending; }
    finally { this.modelWork.delete(pending); this.notifyChanged(); }
  }

  /** A closing view snapshots an admitted draft's promotion without waiting for its response. */
  async awaitIdentitySettlement(): Promise<void> {
    if (!this.conversationId && this.turns.isPreparing) {
      await new Promise<void>(resolve => {
        const check = () => {
          if (!this.conversationId && this.turns.isPreparing) return;
          unsubscribeRuntime();
          unsubscribeTurn();
          resolve();
        };
        const unsubscribeRuntime = this.subscribe(check);
        const unsubscribeTurn = this.turns.subscribe(check);
        check();
      });
    }
    await this.currentModel?.conversationController.awaitCreation();
  }

  get mailbox(): SessionMailbox | null { return this.mailboxOwner; }

  installMailbox(mailbox: SessionMailbox): void {
    if (this.mailboxOwner) throw new Error('Mailbox already installed');
    this.mailboxOwner = mailbox;
    this.subscribe(() => mailbox.wake());
  }

  installSideChat(side: SideChatController): void {
    if (this.childOwner) throw new Error('Side chat owner already installed');
    this.childOwner = side;
  }

  get sideChat(): SideChatController {
    if (!this.childOwner) throw new Error('Side chat owner is not configured');
    return this.childOwner;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  notifyChanged(): void {
    for (const listener of this.listeners) listener();
  }

  /** Delivers a change to the attached presentation, if any, and to session observers once. */
  publish(change: SessionChange): void {
    if (this.currentModel) this.currentModel.publish(change);
    else this.notifyChanged();
  }

  /** Selections survive presentation changes and idle provider release. */
  readonly reasoningSelections = new Map<string, string>();
  readonly providerSelections = new Map<ProviderId, { permissionMode: string; serviceTier: string }>();
  /** The single owner of this session's foreground turn activity. */
  readonly turns = new TurnCoordinator(() => this.admitsConversationOperations);
  private backgroundWork: Promise<void> = Promise.resolve();
  private coordinatorDisposal: Promise<void> | null = null;
  private identityRevisionValue = 0;

  constructor(
    private readonly identity: SessionIdentity,
    private readonly coordinator: ChatExecutionCoordinator,
    private readonly createModel: (session: ChatSessionRuntime) => SessionModel,
  ) {
    let wasActive = false;
    this.turns.subscribe(() => {
      // Session work changes at admission and release; phases within a turn are presentation.
      if (this.turns.isActive === wasActive) return;
      wasActive = this.turns.isActive;
      this.publish('work');
    });
    // A loaded model publishes attention itself; a released one leaves session lists to us.
    this.attention.subscribe(() => {
      if (!this.currentModel) this.notifyChanged();
    });
  }

  get providerId(): ProviderId | null { return this.identity.providerId; }
  get conversationId(): string | null { return this.identity.conversationId; }
  get draftModel(): string | null { return this.identity.draftModel; }
  get executionCoordinator(): ChatExecutionCoordinator { return this.coordinator; }
  get acceptsIntents(): boolean { return this.lifetime === 'open'; }
  get identityRevision(): number { return this.identityRevisionValue; }

  /** Admission is open, execution is allowed, and no conversation transition is running. */
  get admitsConversationOperations(): boolean {
    return this.acceptsIntents && !this.isConversationBusy;
  }

  /**
   * No admitted turn, background work, interaction, or history operation requires the provider.
   */
  get isIdle(): boolean {
    return !this.turns.isActive && this.pendingBackgroundWork === 0 && this.modelWork.size === 0 && !this.hasBackgroundWork && !this.isConversationBusy
      && !this.hasPendingInteraction && !this.mailboxOwner?.hasPending;
  }

  private get isConversationBusy(): boolean {
    return !!this.currentModel?.state.isRewinding;
  }

  /** An approval or question awaits the user. */
  get hasPendingInteraction(): boolean {
    return !!this.currentModel?.hasPendingInteraction;
  }

  get canNavigateConversation(): boolean {
    return this.admitsConversationOperations && !this.turns.isActive && !this.coordinator.hasBackgroundWork;
  }

  /** A foreground response remains active from admission through settlement. */
  get hasActiveTurn(): boolean {
    return this.turns.isResponseActive;
  }

  /** Provider background turns, async subagents, or side chat work that outlives the foreground turn. */
  get hasBackgroundWork(): boolean {
    return this.coordinator.hasBackgroundWork || !!this.currentModel?.hasPendingWork || !!this.childOwner?.isWorking;
  }

  /** Main-destination work already published to the user, excluding detached side work. */
  get hasMainBackgroundWork(): boolean { return this.coordinator.publishedBackgroundWork; }

  /** Any foreground or background work a user can see. */
  get isWorking(): boolean {
    return this.hasActiveTurn || this.hasMainBackgroundWork || !!this.currentModel?.hasPendingWork || !!this.childOwner?.isWorking;
  }

  /**
   * The one cancellation recipe for this session's turn: records the request, aborts the turn,
   * then cancels provider execution. Non-user reasons also release the turn's presentation.
   */
  cancelTurn(reason: TurnCancelReason, options: TurnCancelOptions = {}): boolean {
    if (!options.keepMailbox) this.mailboxOwner?.clear();
    const cancelled = this.turns.cancel(reason);
    try {
      if (options.dismissInteractions) this.currentModel?.dismissInteractions();
    } finally {
      if (cancelled) this.coordinator.cancel();
    }
    return cancelled;
  }

  /** User Stop for published main background work; a settling foreground turn keeps its response. */
  stopMainBackgroundWork(): void {
    if (this.hasMainBackgroundWork) this.coordinator.cancelBackgroundWork();
  }

  /**
   * Shutdown's synchronous fence, ahead of the drain's `cancelTurn`: closes intent admission and
   * aborts the admitted turn, whose signal stops its provider execution. Interactions and detached
   * provider work stay untouched until the drain has joined navigation and close.
   */
  beginShutdown(): void {
    if (this.lifetime !== 'open') return;
    this.lifetime = 'closing';
    this.mailboxOwner?.clear();
    this.turns.cancel('shutdown');
    this.childOwner?.beginShutdown();
  }

  async runConversationNavigation(operation: (signal: AbortSignal) => Promise<unknown>): Promise<void> {
    if (!this.canNavigateConversation) return;
    await this.turns.run(async signal => { await operation(signal); }, 'navigation');
  }

  bindConversation(conversationId: string | null, providerId: ProviderId | null): void {
    this.replaceIdentity(conversationId, providerId, null);
  }

  selectDraft(providerId: ProviderId | null, model: string | null): void {
    if (this.conversationId !== null) throw new Error('Cannot select a draft on a bound session');
    this.replaceIdentity(null, providerId, model);
  }

  setConversationId(conversationId: string | null): void {
    this.replaceIdentity(conversationId, this.providerId, conversationId ? null : this.draftModel);
  }

  private replaceIdentity(conversationId: string | null, providerId: ProviderId | null, draftModel: string | null): void {
    if (this.conversationId !== null && (conversationId !== this.conversationId || providerId !== this.providerId)) {
      throw new Error('Cannot replace the identity of a bound session');
    }
    if (this.conversationId !== conversationId || this.providerId !== providerId || this.draftModel !== draftModel) {
      this.identityRevisionValue++;
      Object.assign(this.identity, { conversationId, providerId, draftModel });
      this.publish('identity');
    }
  }

  private async disposeExecutionCoordinator(): Promise<void> {
    if (!this.coordinatorDisposal) {
      this.coordinatorDisposal = Promise.resolve().then(() => this.coordinator.dispose());
    }
    await this.coordinatorDisposal;
  }

  enqueueBackgroundWork(work: () => Promise<void>, independent = false): Promise<void> | null {
    if (this.isDisposed) return null;

    const previous = this.backgroundWork.catch(() => undefined);
    // Independent notifications must precede reservations from later native events.
    const pending = independent ? (async () => work())() : previous.then(work);
    this.pendingBackgroundWork++;
    void pending.finally(() => {
      this.pendingBackgroundWork--;
      this.notifyChanged();
    }).catch(() => undefined);
    this.backgroundWork = independent
      ? Promise.allSettled([previous, pending]).then(() => undefined)
      : pending;
    return pending;
  }

  async awaitBackgroundWork(): Promise<void> {
    await this.backgroundWork.catch(() => undefined);
  }

  dispose(options: { save?: boolean } = {}): Promise<void> {
    this.beginShutdown();
    return this.disposal ??= this.disposeOnce(options.save !== false);
  }

  private async disposeOnce(save: boolean): Promise<void> {
    if (!this.cancelTurn('shutdown', { dismissInteractions: true })) this.coordinator.cancel();
    const model = this.currentModel;
    const results = await Promise.allSettled([
      // An admitted first turn can still launch its title request until the turn settles.
      this.turns.drain().finally(() => model?.drainAuxiliaryWork()),
      model?.inputController.drainSessionMentionPreparations(),
      this.awaitBackgroundWork(),
      ...this.modelWork,
      this.childOwner?.dispose(),
    ]);
    if (save && model && this.conversationId) {
      results.push(await model.conversationController.save(false)
        .then(value => ({ status: 'fulfilled' as const, value }), (reason: unknown) => ({ status: 'rejected' as const, reason })));
    }
    results.push(await this.disposeExecutionCoordinator()
      .then(value => ({ status: 'fulfilled' as const, value }), (reason: unknown) => ({ status: 'rejected' as const, reason })));
    model?.dispose();
    this.currentModel = null;
    this.lifetime = 'disposed';
    this.listeners.clear();
    const failures = results.filter(result => result.status === 'rejected');
    if (failures.length) throw new AggregateError(failures.map(result => result.reason as unknown), 'Failed to drain session');
  }
}
