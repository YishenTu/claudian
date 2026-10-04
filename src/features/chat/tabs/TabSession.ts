import type { ProviderId } from '../../../core/providers/types';
import { type TurnCancelReason, TurnCoordinator } from '../controllers/TurnCoordinator';
import type { ChatExecutionCoordinator } from '../execution/ChatExecutionCoordinator';
import type { TabLifecycleState } from './types';

export interface TabSessionState {
  conversationId: string | null;
  draftModel: string | null;
  id: string;
  lifecycleState: TabLifecycleState;
  providerId: ProviderId | null;
}

export interface TabSessionOptions {
  /** Shared with presentation state built before the session; its admission must use `admitsConversationOperations`. */
  turns?: TurnCoordinator;
  onWorkChanged?: () => void;
  isConversationBusy?: () => boolean;
  /** Work the execution coordinator does not own, such as async subagents and side chat. */
  hasDetachedWork?: () => boolean;
  /** Expires every pending prompt, including ones outside the active turn. */
  dismissInteractions?: () => void;
}

export interface TurnCancelOptions {
  dismissInteractions?: boolean;
}

export class TabSession {
  /** Runtime selections survive tab activation and idle session release, but not tab disposal. */
  readonly reasoningSelections = new Map<string, string>();
  /** The single owner of this tab's foreground turn activity. */
  readonly turns: TurnCoordinator;
  private backgroundWork: Promise<void> = Promise.resolve();
  private backgroundWorkPauseDepth = 0;
  private coordinatorDisposal: Promise<void> | null = null;
  private intentAdmissionPauseDepth = 0;
  private userOwnershipRevisionValue = 0;
  private identityRevisionValue = 0;
  private identitySealed = false;

  constructor(
    private readonly state: TabSessionState,
    private readonly coordinator: ChatExecutionCoordinator,
    private readonly options: TabSessionOptions = {},
  ) {
    this.turns = options.turns ?? new TurnCoordinator(() => this.admitsConversationOperations);
    let wasActive = false;
    this.turns.subscribe(() => {
      // Session work changes at admission and release; phases within a turn are presentation.
      if (this.turns.isActive === wasActive) return;
      wasActive = this.turns.isActive;
      this.options.onWorkChanged?.();
    });
  }

  get id(): string { return this.state.id; }
  get lifecycleState(): TabLifecycleState { return this.state.lifecycleState; }
  get providerId(): ProviderId | null { return this.state.providerId; }
  get conversationId(): string | null { return this.state.conversationId; }
  get draftModel(): string | null { return this.state.draftModel; }
  get executionCoordinator(): ChatExecutionCoordinator { return this.coordinator; }
  get acceptsIntents(): boolean { return this.intentAdmissionPauseDepth === 0; }
  get userOwnershipRevision(): number { return this.userOwnershipRevisionValue; }
  get identityRevision(): number { return this.identityRevisionValue; }

  /** Admission is open, the tab is not closing, and no conversation transition is running. */
  get admitsConversationOperations(): boolean {
    return this.acceptsIntents && this.lifecycleState !== 'closing' && !this.identitySealed
      && !this.isConversationBusy;
  }

  /** No turn, background work, conversation transition, or close holds the tab, so its provider session may be released. */
  get isIdle(): boolean {
    return !this.turns.isActive && !this.hasBackgroundWork && !this.isConversationBusy
      && this.lifecycleState !== 'closing';
  }

  private get isConversationBusy(): boolean {
    return this.options.isConversationBusy?.() ?? false;
  }

  get canNavigateConversation(): boolean {
    return this.admitsConversationOperations && !this.turns.isActive && !this.coordinator.hasBackgroundWork;
  }

  /** A foreground response holds the tab, from admission through settlement. */
  get hasActiveTurn(): boolean {
    return this.turns.isResponseActive;
  }

  /** Provider background turns, async subagents, or side chat work that outlives the foreground turn. */
  get hasBackgroundWork(): boolean {
    return this.coordinator.hasBackgroundWork || (this.options.hasDetachedWork?.() ?? false);
  }

  /** Any foreground or background work a user can see; closing the tab would interrupt it. */
  get isWorking(): boolean {
    return this.hasActiveTurn || this.hasBackgroundWork;
  }

  /**
   * The one cancellation recipe for this tab's turn: records the request, aborts the turn,
   * then cancels provider execution. Non-user reasons also release the turn's presentation.
   */
  cancelTurn(reason: TurnCancelReason, options: TurnCancelOptions = {}): boolean {
    const cancelled = this.turns.cancel(reason);
    try {
      if (options.dismissInteractions) this.options.dismissInteractions?.();
    } finally {
      if (cancelled) this.coordinator.cancel();
    }
    return cancelled;
  }

  /**
   * Shutdown's synchronous fence, ahead of the drain's `cancelTurn`: closes intent admission and
   * aborts the admitted turn, whose signal stops its provider execution. Interactions and detached
   * provider work stay untouched until the drain has joined navigation and close.
   */
  beginShutdown(): void {
    this.pauseIntentAdmission();
    this.turns.cancel('shutdown');
  }

  async runConversationNavigation(operation: (signal: AbortSignal) => Promise<unknown>): Promise<void> {
    if (!this.canNavigateConversation) return;
    await this.turns.run(async signal => { await operation(signal); }, 'navigation');
  }

  bindConversation(conversationId: string | null, providerId: ProviderId | null): void {
    this.replaceIdentity(conversationId, providerId, null);
  }

  selectDraft(providerId: ProviderId | null, model: string | null): void {
    if (this.conversationId !== null) throw new Error('Cannot select a draft on a bound tab');
    this.replaceIdentity(null, providerId, model);
  }

  startDraft(providerId: ProviderId | null, model: string | null): void {
    this.replaceIdentity(null, providerId, model);
  }

  setConversationId(conversationId: string | null): void {
    this.replaceIdentity(conversationId, this.providerId, conversationId ? null : this.draftModel);
  }

  private replaceIdentity(conversationId: string | null, providerId: ProviderId | null, draftModel: string | null): void {
    if (this.identitySealed) return;
    if (this.conversationId !== conversationId || this.providerId !== providerId || this.draftModel !== draftModel) {
      this.identityRevisionValue++;
      Object.assign(this.state, { conversationId, providerId, draftModel });
    }
  }

  commitAdmission(): void {
    if (this.lifecycleState === 'provisional') this.state.lifecycleState = 'open';
  }

  sealIdentity(): void {
    this.identitySealed = true;
    this.identityRevisionValue++;
  }

  beginClose(): void {
    this.state.lifecycleState = 'closing';
  }

  claimUserOwnership(): void {
    this.userOwnershipRevisionValue += 1;
  }

  pauseIntentAdmission(): void {
    this.intentAdmissionPauseDepth += 1;
  }

  resumeIntentAdmission(): void {
    this.intentAdmissionPauseDepth = Math.max(0, this.intentAdmissionPauseDepth - 1);
  }

  async disposeExecutionCoordinator(): Promise<void> {
    if (!this.coordinatorDisposal) {
      this.coordinatorDisposal = Promise.resolve().then(() => this.coordinator.dispose());
    }
    await this.coordinatorDisposal;
  }

  enqueueBackgroundWork(work: () => Promise<void>, independent = false): Promise<void> | null {
    if (this.backgroundWorkPauseDepth > 0) return null;

    const previous = this.backgroundWork.catch(() => undefined);
    // Independent notifications must precede reservations from later native events.
    const pending = independent ? (async () => work())() : previous.then(work);
    this.backgroundWork = independent
      ? Promise.allSettled([previous, pending]).then(() => undefined)
      : pending;
    return pending;
  }

  async awaitBackgroundWork(): Promise<void> {
    await this.backgroundWork.catch(() => undefined);
  }

  pauseBackgroundWork(): void {
    this.backgroundWorkPauseDepth++;
  }

  resumeBackgroundWork(): void {
    this.backgroundWorkPauseDepth = Math.max(0, this.backgroundWorkPauseDepth - 1);
  }
}
