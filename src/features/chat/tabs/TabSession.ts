import type { ProviderId } from '../../../core/providers/types';
import { RuntimeSupervisor } from './RuntimeSupervisor';
import type { TabLifecycleState } from './types';

export interface TabSessionState {
  conversationId: string | null;
  draftModel: string | null;
  id: string;
  lifecycleState: TabLifecycleState;
  providerId: ProviderId;
}

export class TabSession {
  readonly runtimeSupervisor = new RuntimeSupervisor();
  activeTurn: Promise<void> | null = null;
  private backgroundWork: Promise<void> = Promise.resolve();
  private backgroundWorkPauseDepth = 0;

  constructor(private readonly state: TabSessionState) {}

  get id(): string { return this.state.id; }
  get lifecycleState(): TabLifecycleState { return this.state.lifecycleState; }
  set lifecycleState(value: TabLifecycleState) { this.state.lifecycleState = value; }
  get providerId(): ProviderId { return this.state.providerId; }
  set providerId(value: ProviderId) { this.state.providerId = value; }
  get conversationId(): string | null { return this.state.conversationId; }
  set conversationId(value: string | null) { this.state.conversationId = value; }
  get draftModel(): string | null { return this.state.draftModel; }
  set draftModel(value: string | null) { this.state.draftModel = value; }

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
