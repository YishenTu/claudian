import { randomUUID } from 'node:crypto';

import type {
  ProviderExecutionBackend,
  ProviderExecutionEvent,
  ProviderExecutionRequest,
  ProviderExecutionRun,
  ProviderExecutionSession,
  ProviderSessionConfig,
  ProviderSessionEvent,
  ProviderSessionSnapshot,
  ProviderSessionStatus,
} from '@/core/execution';

type WithoutScope<T> = T extends unknown ? Omit<T, 'scope'> : never;

export class FakeAuxiliarySession implements ProviderExecutionSession {
  readonly providerId = 'claude' as const;
  readonly sessionInstanceId = randomUUID();
  readonly requests: ProviderExecutionRequest[] = [];
  cancelCalls = 0;
  disposeCalls = 0;
  private active: FakeRun | null = null;
  private status: ProviderSessionStatus = 'idle';

  execute(request: ProviderExecutionRequest): ProviderExecutionRun {
    if (this.active) throw new Error('active');
    this.requests.push(request);
    this.status = 'executing';
    const run = new FakeRun(this.sessionInstanceId, () => this.cancel());
    this.active = run;
    return run;
  }

  emitText(text: string): void {
    this.active?.emit({ text, type: 'text_delta' });
  }

  complete(): void {
    this.status = 'idle';
    this.active?.finish({ reason: 'completed', type: 'turn_completed' });
    this.active = null;
  }

  fail(message: string): void {
    this.status = 'invalidated';
    this.active?.finish({
      category: 'provider',
      message,
      recoverable: true,
      type: 'execution_error',
    });
    this.active = null;
  }

  cancel(): void {
    this.cancelCalls += 1;
    this.status = 'idle';
    this.active?.finish({ reason: 'Cancelled', type: 'cancelled' });
    this.active = null;
  }

  getSnapshot(): ProviderSessionSnapshot {
    return this.status === 'invalidated'
      ? {
        invalidation: { reason: 'provider-error', recoverable: true },
        providerId: this.providerId,
        revision: 1,
        status: 'invalidated',
      }
      : {
        providerId: this.providerId,
        revision: 1,
        status: this.status,
      };
  }

  getStatus(): ProviderSessionStatus {
    return this.status;
  }

  onEvent(_listener: (event: ProviderSessionEvent) => void): () => void {
    return () => undefined;
  }

  async dispose(): Promise<void> {
    this.disposeCalls += 1;
    this.cancel();
    this.status = 'disposed';
  }
}

export class FakeAuxiliaryBackend implements ProviderExecutionBackend {
  readonly providerId = 'claude' as const;
  readonly sessions: FakeAuxiliarySession[] = [];
  readonly configs: ProviderSessionConfig[] = [];

  createSession(config: ProviderSessionConfig): ProviderExecutionSession {
    this.configs.push(config);
    const session = new FakeAuxiliarySession();
    this.sessions.push(session);
    return session;
  }
}

export async function waitFor(
  predicate: () => boolean,
  message = 'auxiliary execution condition',
): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) return;
    await new Promise(resolve => setImmediate(resolve));
  }
  throw new Error(`Timed out waiting for ${message}`);
}

class FakeRun implements ProviderExecutionRun {
  readonly executionId = randomUUID();
  readonly turnId = randomUUID();
  readonly events: AsyncIterable<ProviderExecutionEvent>;
  private readonly queue = new EventQueue<ProviderExecutionEvent>();
  private sequence = 0;

  constructor(
    private readonly sessionInstanceId: string,
    private readonly onCancel: () => void,
  ) {
    this.events = this.queue;
  }

  emit(event: WithoutScope<ProviderExecutionEvent>): void {
    this.queue.push({
      ...event,
      scope: this.scope(),
    } as ProviderExecutionEvent);
  }

  finish(event: WithoutScope<ProviderExecutionEvent>): void {
    this.emit(event);
    this.queue.close();
  }

  cancel(): void {
    this.onCancel();
  }

  private scope() {
    return {
      executionId: this.executionId,
      kind: 'requested' as const,
      sequence: ++this.sequence,
      sessionInstanceId: this.sessionInstanceId,
      turnId: this.turnId,
    };
  }
}

class EventQueue<T> implements AsyncIterable<T>, AsyncIterator<T> {
  private closed = false;
  private readonly values: T[] = [];
  private readonly waiters: Array<(result: IteratorResult<T>) => void> = [];

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return this;
  }

  next(): Promise<IteratorResult<T>> {
    const value = this.values.shift();
    if (value !== undefined) return Promise.resolve({ done: false, value });
    if (this.closed) return Promise.resolve({ done: true, value: undefined });
    return new Promise(resolve => this.waiters.push(resolve));
  }

  push(value: T): void {
    const waiter = this.waiters.shift();
    if (waiter) waiter({ done: false, value });
    else this.values.push(value);
  }

  close(): void {
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) {
      waiter({ done: true, value: undefined });
    }
  }
}
