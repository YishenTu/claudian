import type { ProviderId } from '../../../core/providers/types';
import type { ChatExecutionCoordinator } from '../execution/ChatExecutionCoordinator';
import type { TabLifecycleState } from './types';

export interface TabSessionState {
  conversationId: string | null;
  draftModel: string | null;
  id: string;
  lifecycleState: TabLifecycleState;
  providerId: ProviderId | null;
}

export class TabSession {
  /** Runtime selections survive tab activation and execution cooling, but not tab disposal. */
  readonly reasoningSelections = new Map<string, string>();
  private activeTurnValue: Promise<void> | null = null;
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
    private readonly onWorkChanged?: () => void,
  ) {}

  get id(): string { return this.state.id; }
  get lifecycleState(): TabLifecycleState { return this.state.lifecycleState; }
  get providerId(): ProviderId | null { return this.state.providerId; }
  get conversationId(): string | null { return this.state.conversationId; }
  get draftModel(): string | null { return this.state.draftModel; }
  get executionCoordinator(): ChatExecutionCoordinator { return this.coordinator; }
  get acceptsIntents(): boolean { return this.intentAdmissionPauseDepth === 0; }
  get userOwnershipRevision(): number { return this.userOwnershipRevisionValue; }
  get activeTurn(): Promise<void> | null { return this.activeTurnValue; }
  set activeTurn(value: Promise<void> | null) {
    const wasActive = this.activeTurnValue !== null;
    this.activeTurnValue = value;
    if (wasActive !== (value !== null)) this.onWorkChanged?.();
    if (value === null) this.coordinator.notifyMayCool();
  }

  get identityRevision(): number { return this.identityRevisionValue; }

  bindConversation(conversationId: string | null, providerId: ProviderId | null): void {
    this.replaceIdentity(conversationId, providerId, null);
    this.setExecutionWarm(false);
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
    if (this.lifecycleState === 'provisional') this.state.lifecycleState = 'cold';
  }

  sealIdentity(): void {
    this.identitySealed = true;
    this.identityRevisionValue++;
  }

  beginClose(): void {
    this.state.lifecycleState = 'closing';
  }

  setExecutionWarm(warm: boolean): void {
    if (this.lifecycleState === 'closing' || this.lifecycleState === 'provisional') return;
    this.state.lifecycleState = warm ? 'warm' : 'cold';
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
