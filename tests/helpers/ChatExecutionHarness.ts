import { type ProviderExecutionBackend, type ProviderExecutionEvent, ProviderExecutionLifecycleRegistry, type ProviderExecutionRequest, type ProviderExecutionRun, type ProviderExecutionSession, type ProviderInteractionPort, type ProviderSessionConfig, type ProviderSessionEvent, type ProviderSessionSnapshot, type ProviderSessionStatus, type RewindableExecutionSession, type SteerableExecutionSession } from '@/core/execution';
import type { ProviderId, SlashCommand } from '@/core/types';
import { ChatExecutionCoordinator, type ChatExecutionCoordinatorDeps, type ChatExecutionEventContext, type ChatExecutionPersistence, type ChatTurnSubmission, type MissingProviderSessionResolution } from '@/features/chat/execution/ChatExecutionCoordinator';
import type { WarmExecutionPool } from '@/features/chat/execution/WarmExecutionPool';
import { type WarmExecutionOwner } from '@/features/chat/execution/WarmExecutionPool';

class EventQueue<T> implements AsyncIterable<T> {
  private readonly values: T[] = [];
  private readonly waiters: Array<(result: IteratorResult<T>) => void> = [];
  private ended = false;

  push(value: T): void {
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter({ done: false, value });
      return;
    }
    this.values.push(value);
  }

  end(): void {
    this.ended = true;
    for (const waiter of this.waiters.splice(0)) {
      waiter({ done: true, value: undefined });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: async () => {
        const value = this.values.shift();
        if (value) return { done: false, value };
        if (this.ended) return { done: true, value: undefined };
        return new Promise<IteratorResult<T>>((resolve) => {
          this.waiters.push(resolve);
        });
      },
      return: async () => {
        this.end();
        return { done: true, value: undefined };
      },
    };
  }
}

export class FakeRun implements ProviderExecutionRun {
  readonly events = new EventQueue<ProviderExecutionEvent>();
  cancelCalls = 0;

  constructor(
    readonly executionId: string,
    readonly turnId: string,
  ) {}

  cancel(): void {
    this.cancelCalls += 1;
    this.events.end();
  }
}

export class FakeSession implements ProviderExecutionSession,
  SteerableExecutionSession,
  RewindableExecutionSession {
  readonly requests: ProviderExecutionRequest[] = [];
  readonly runs: FakeRun[] = [];
  readonly steerRequests: ProviderExecutionRequest[] = [];
  readonly listeners = new Set<(event: ProviderSessionEvent) => void>();
  commands: SlashCommand[] | undefined;
  getCommandSnapshot() { return this.commands; }
  cancelCalls = 0;
  disposeCalls = 0;
  status: ProviderSessionStatus = 'idle';
  snapshot: ProviderSessionSnapshot;
  steerResult = true;
  rewindResult = {
    canRewind: true,
    sessionStrategy: 'preserve-provider-session' as const,
  };

  constructor(
    readonly providerId: ProviderId,
    readonly sessionInstanceId: string,
  ) {
    this.snapshot = {
      providerId,
      revision: 0,
      status: 'idle',
    };
  }

  execute(request: ProviderExecutionRequest): ProviderExecutionRun {
    this.requests.push(request);
    const run = new FakeRun(
      `execution-${this.runs.length + 1}`,
      `turn-${this.runs.length + 1}`,
    );
    this.runs.push(run);
    return run;
  }

  async steer(request: ProviderExecutionRequest): Promise<boolean> {
    this.steerRequests.push(request);
    return this.steerResult;
  }

  async previewRewind(): Promise<{ canRewind: boolean }> {
    return { canRewind: true };
  }

  async rewind(): Promise<typeof this.rewindResult> {
    return this.rewindResult;
  }

  cancel(): void {
    this.cancelCalls += 1;
  }

  getSnapshot(): ProviderSessionSnapshot {
    return this.snapshot;
  }

  getStatus(): ProviderSessionStatus {
    return this.status;
  }

  onEvent(listener: (event: ProviderSessionEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(event: ProviderSessionEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  async dispose(): Promise<void> {
    this.disposeCalls += 1;
    this.status = 'disposed';
  }
}

class FakeBackend implements ProviderExecutionBackend {
  readonly configs: ProviderSessionConfig[] = [];
  readonly sessions: FakeSession[] = [];

  constructor(readonly providerId: ProviderId) {}

  createSession(config: ProviderSessionConfig): ProviderExecutionSession {
    this.configs.push(config);
    const session = new FakeSession(
      this.providerId,
      `${this.providerId}-session-${this.sessions.length + 1}`,
    );
    this.sessions.push(session);
    return session;
  }
}

export function requestedScope(
  session: FakeSession,
  run: FakeRun,
  sequence: number,
): ProviderExecutionEvent['scope'] {
  return {
    kind: 'requested',
    sessionInstanceId: session.sessionInstanceId,
    executionId: run.executionId,
    turnId: run.turnId,
    sequence,
  };
}

export function createSubmission(overrides: Partial<ChatTurnSubmission> = {}): ChatTurnSubmission {
  return {
    submissionId: 'input-1',
    timestamp: 123,
    rawDisplayText: 'raw input',
    canonicalText: 'canonical input',
    images: [],
    context: {
      linkedContent: { path: 'note.md', content: 'note' },
    },
    conversationHistory: [],
    configuration: {
      systemInstructions: { kind: 'provider-default' },
      model: 'model-1',
    },
    toolPolicy: { kind: 'provider-default' },
    ...overrides,
  };
}

export function createHarness(options: {
  onBackgroundWorkChanged?: (isWorking: boolean) => void;
  onError?: (error: unknown) => void;
  onRequestedEvent?: (
    event: ProviderExecutionEvent,
  ) => void | Promise<void>;
  onSessionEvent?: (
    event: ProviderSessionEvent,
    context: ChatExecutionEventContext,
  ) => void | Promise<void>;
  warmExecution?: ChatExecutionCoordinatorDeps['warmExecution'];
} = {}) {
  const registry = new ProviderExecutionLifecycleRegistry();
  const backends = new Map<ProviderId, FakeBackend>([
    ['claude', new FakeBackend('claude')],
    ['codex', new FakeBackend('codex')],
  ]);
  const repository = {
    registerExecutionBinding: jest.fn(),
    persistExecutionSnapshot: jest.fn(async () => true),
    releaseExecutionBinding: jest.fn(),
    recordConversationActivity: jest.fn(async () => undefined),
    assertConversationExecutionAuthority: jest.fn(async () => undefined),
  } as unknown as jest.Mocked<ChatExecutionPersistence>;
  const interactionPort = {
    requestApproval: jest.fn(async ({ interactionId }) => ({
      interactionId,
      decision: 'allow',
    })),
    askUserQuestion: jest.fn(async ({ interactionId }) => ({
      interactionId,
      answers: null,
    })),
    dismissInteraction: jest.fn(),
  } as unknown as jest.Mocked<ProviderInteractionPort>;
  const requestedEvents: ProviderExecutionEvent[] = [];
  const sessionEvents: ProviderSessionEvent[] = [];
  const sessionEventContexts: ChatExecutionEventContext[] = [];
  const missingSession = jest.fn<
    Promise<MissingProviderSessionResolution>,
    [string, string?]
  >(async () => 'reset');
  let nextId = 0;
  const coordinator = new ChatExecutionCoordinator({
    lifecycleRegistry: registry,
    resolveBackend: (providerId) => {
      const backend = backends.get(providerId);
      if (!backend) throw new Error(`Missing backend: ${providerId}`);
      return backend;
    },
    persistence: repository,
    interactionPort,
    vaultWorkingDirectory: '/vault',
    createId: () => `local-${++nextId}`,
    onRequestedEvent: options.onRequestedEvent ?? ((event) => {
      requestedEvents.push(event);
    }),
    onSessionEvent: (event, context) => {
      sessionEvents.push(event);
      sessionEventContexts.push(context);
      return options.onSessionEvent?.(event, context);
    },
    onBackgroundWorkChanged: options.onBackgroundWorkChanged,
    onError: options.onError,
    resolveMissingProviderSession: missingSession,
    ...(options.warmExecution ? { warmExecution: options.warmExecution } : {}),
  });

  return {
    registry,
    backends,
    repository,
    interactionPort,
    requestedEvents,
    sessionEvents,
    sessionEventContexts,
    missingSession,
    coordinator,
  };
}

export function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

export async function beginExecution(
  harness: ReturnType<typeof createHarness>,
  submission = createSubmission(),
) {
  await harness.coordinator.bindConversation({
    conversationId: 'conversation-1',
    providerId: 'claude',
    resumeSeed: {
      providerSessionId: 'native-session',
      providerState: { leafId: 'leaf-1' },
    },
  });
  const resultPromise = harness.coordinator.execute(submission);
  let session: FakeSession | undefined;
  let run: FakeRun | undefined;
  for (let attempt = 0; attempt < 20 && !run; attempt += 1) {
    await Promise.resolve();
    session = harness.backends.get('claude')!.sessions[0];
    run = session?.runs[0];
  }
  if (!session || !run) throw new Error('Execution did not start');
  return { session, run, resultPromise };
}

export async function reserveProtectedWarmSlots(
  pool: WarmExecutionPool,
  count = 4,
): Promise<WarmExecutionOwner[]> {
  const owners = Array.from({ length: count }, (_, index) => ({
    id: `reserved-${index}`,
    canCool: () => false,
    cool: jest.fn().mockResolvedValue(undefined),
  }));
  for (const owner of owners) {
    await pool.acquire(owner);
  }
  return owners;
}
