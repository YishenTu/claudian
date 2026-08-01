import type { ProviderId } from '../types/provider';
import type {
  ProviderExecutionEvent,
  ProviderSessionEvent,
} from './ProviderExecutionEvent';
import type { ProviderExecutionRequest } from './ProviderExecutionRequest';
import type {
  ProviderSessionSnapshot,
  ProviderSessionStatus,
} from './ProviderSessionSnapshot';

export interface ProviderExecutionRun {
  /** Claudian-local identities shared by every requested event envelope. */
  readonly executionId: string;
  readonly turnId: string;
  /**
   * Terminates exactly once with turn_completed, cancelled, or execution_error.
   * Ending iteration early cancels native work and detaches run listeners.
   */
  readonly events: AsyncIterable<ProviderExecutionEvent>;
  /** Idempotently cancels only this requested execution. */
  cancel(): void;
}

/**
 * One independent provider-native session/process lifecycle.
 *
 * Implementations accept at most one requested execution at a time. Expected
 * provider, transport, cancellation, and missing-session failures terminate
 * the run stream; only API misuse fails directly. Disposal is idempotent,
 * cancels native work and pending interactions, fences late events, and
 * prevents later execution. Requested events are never duplicated through
 * the session-level listener channel.
 */
export interface ProviderExecutionSession {
  readonly providerId: ProviderId;
  readonly sessionInstanceId: string;
  execute(request: ProviderExecutionRequest): ProviderExecutionRun;
  cancel(): void;
  getSnapshot(): ProviderSessionSnapshot;
  getStatus(): ProviderSessionStatus;
  onEvent(listener: (event: ProviderSessionEvent) => void): () => void;
  dispose(): Promise<void>;
}
