import { RuntimeSupervisor } from '../../../app/runtime/RuntimeSupervisor';
import type { ProviderId } from '../../../core/providers/types';
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
}
