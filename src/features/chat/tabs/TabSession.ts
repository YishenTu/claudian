import type { ProviderId } from '../../../core/providers/types';
import type { ChatExecutionCoordinator } from '../execution/ChatExecutionCoordinator';
import type { TabLifecycleState } from './types';

export interface TabSessionState {
  conversationId: string | null;
  draftModel: string | null;
  id: string;
  lifecycleState: TabLifecycleState;
  providerId: ProviderId;
}

export class TabSession {
  private activeTurnValue: Promise<void> | null = null;
  private backgroundWork: Promise<void> = Promise.resolve();
  private backgroundWorkPauseDepth = 0;
  private coordinatorDisposal: Promise<void> | null = null;
  private intentAdmissionPauseDepth = 0;
  private userOwnershipRevisionValue = 0;

  constructor(
    private readonly state: TabSessionState,
    private readonly coordinator: ChatExecutionCoordinator,
    private readonly onWorkChanged?: () => void,
  ) {}

  get id(): string { return this.state.id; }
  get lifecycleState(): TabLifecycleState { return this.state.lifecycleState; }
  set lifecycleState(value: TabLifecycleState) { this.state.lifecycleState = value; }
  get providerId(): ProviderId { return this.state.providerId; }
  set providerId(value: ProviderId) { this.state.providerId = value; }
  get conversationId(): string | null { return this.state.conversationId; }
  set conversationId(value: string | null) { this.state.conversationId = value; }
  get draftModel(): string | null { return this.state.draftModel; }
  set draftModel(value: string | null) { this.state.draftModel = value; }
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

  enqueueBackgroundWork(work: () => Promise<void>): Promise<void> | null {
    if (this.backgroundWorkPauseDepth > 0) return null;

    const pending = this.backgroundWork
      .catch(() => undefined)
      .then(work);
    this.backgroundWork = pending;
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
