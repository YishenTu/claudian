import { randomUUID } from 'node:crypto';

import { ExecutionEventQueue } from './ExecutionEventQueue';
import type {
  ProviderCancelledEvent,
  ProviderExecutionErrorEvent,
  ProviderExecutionEvent,
  ProviderRequestedEventScope,
  ProviderTurnCompletedEvent,
  WithoutEventScope,
} from './ProviderExecutionEvent';
import type { ProviderExecutionRun } from './ProviderExecutionSession';

export type RequestedRunEvent = WithoutEventScope<ProviderExecutionEvent>;

export type RequestedRunTerminalEvent = WithoutEventScope<
  | ProviderTurnCompletedEvent
  | ProviderCancelledEvent
  | ProviderExecutionErrorEvent
>;

/** `consumer` covers `cancel()` and early stream return; `abort-signal` is the request signal. */
export type RequestedRunCancelSource = 'consumer' | 'abort-signal';

export interface RequestedRunChannelOptions {
  readonly sessionInstanceId: string;
  /**
   * Called at most once, for the first cancellation before termination.
   * The provider owns native teardown and must still terminate the run.
   */
  readonly onCancel: (source: RequestedRunCancelSource) => void;
}

/**
 * Provider-neutral stream for one requested execution: a single-consumer
 * queue, immutable sequence-numbered scopes, exactly one terminal event, and
 * request-signal cancellation that detaches on termination.
 */
export class RequestedRunChannel implements ProviderExecutionRun {
  readonly sessionInstanceId: string;
  readonly executionId = randomUUID();
  readonly turnId = randomUUID();
  readonly events: AsyncIterable<ProviderExecutionEvent>;
  /** Resolves when the stream terminates, with or without a terminal event. */
  readonly terminated: Promise<void>;

  readonly #queue: ExecutionEventQueue<ProviderExecutionEvent>;
  readonly #options: RequestedRunChannelOptions;
  #sequence = 0;
  #terminal = false;
  #cancellationRequested = false;
  #detachAbortSignal: (() => void) | null = null;
  #resolveTerminated!: () => void;

  constructor(options: RequestedRunChannelOptions) {
    this.#options = options;
    this.sessionInstanceId = options.sessionInstanceId;
    this.#queue = new ExecutionEventQueue<ProviderExecutionEvent>(() => this.cancel());
    this.events = this.#queue;
    this.terminated = new Promise(resolve => { this.#resolveTerminated = resolve; });
  }

  get isTerminal(): boolean {
    return this.#terminal;
  }

  get isCancellationRequested(): boolean {
    return this.#cancellationRequested;
  }

  /** Scopes and enqueues a non-terminal event; returns null once terminal. */
  emit(event: RequestedRunEvent): ProviderRequestedEventScope | null {
    if (this.#terminal) return null;
    const scope: ProviderRequestedEventScope = Object.freeze({
      kind: 'requested',
      sessionInstanceId: this.sessionInstanceId,
      executionId: this.executionId,
      turnId: this.turnId,
      sequence: ++this.#sequence,
    });
    this.#queue.push({ ...event, scope });
    return scope;
  }

  /** Emits the single terminal event and closes the stream; later calls return null. */
  finish(event: RequestedRunTerminalEvent): ProviderRequestedEventScope | null {
    const scope = this.emit(event);
    if (scope) this.#terminate();
    return scope;
  }

  /**
   * Closes the stream without a terminal event. Only for internal control
   * operations whose stream is never handed to a consumer.
   */
  close(): void {
    if (!this.#terminal) this.#terminate();
  }

  cancel(): void {
    this.#requestCancellation('consumer');
  }

  /** Cancels when the signal aborts, including an already-aborted signal. */
  attachAbortSignal(signal: AbortSignal): void {
    if (this.#terminal) return;
    this.#detachAbortSignal?.();
    const onAbort = (): void => this.#requestCancellation('abort-signal');
    signal.addEventListener('abort', onAbort, { once: true });
    this.#detachAbortSignal = () => signal.removeEventListener('abort', onAbort);
    if (signal.aborted) onAbort();
  }

  #requestCancellation(source: RequestedRunCancelSource): void {
    if (this.#terminal || this.#cancellationRequested) return;
    this.#cancellationRequested = true;
    this.#options.onCancel(source);
  }

  #terminate(): void {
    this.#terminal = true;
    this.#detachAbortSignal?.();
    this.#detachAbortSignal = null;
    this.#queue.close();
    this.#resolveTerminated();
  }
}
