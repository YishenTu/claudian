import type { Mocked } from 'vitest';

import { type BranchableExecutionSession, type ConversationBranchState, type ProviderExecutionBackend, type ProviderExecutionEvent, ProviderExecutionLifecycleRegistry, type ProviderExecutionRequest, type ProviderExecutionRun, type ProviderExecutionSession, type ProviderInteractionPort, type ProviderSessionConfig, type ProviderSessionEvent, type ProviderSessionSnapshot, type ProviderSessionStatus, type RewindableExecutionSession, type SteerableExecutionSession } from '@/core/execution';
import type { ProviderId, SlashCommand } from '@/core/types';
import { ChatExecutionCoordinator, type ChatExecutionCoordinatorDeps, type ChatExecutionEventContext, type ChatExecutionPersistence, type ChatTurnSubmission, type MissingProviderSessionResolution } from '@/features/chat/execution/ChatExecutionCoordinator';



class EventQueue<T> implements AsyncIterable<T> {
  private readonly values: T[] = [];
  private readonly waiters: Array<{ resolve: (result: IteratorResult<T>) => void; reject: (error: unknown) => void }> = [];
  private failure: { error: unknown } | null = null;
  private ended = false;

  push(value: T): void {
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter.resolve({ done: false, value });
      return;
    }
    this.values.push(value);
  }

  end(): void {
    this.ended = true;
    for (const waiter of this.waiters.splice(0)) {
      waiter.resolve({ done: true, value: undefined });
    }
  }

  fail(error: unknown): void {
    this.failure = { error };
    for (const waiter of this.waiters.splice(0)) waiter.reject(error);
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: async () => {
        const value = this.values.shift();
        if (value) return { done: false, value };
        if (this.failure) throw this.failure.error;
        if (this.ended) return { done: true, value: undefined };
        return new Promise<IteratorResult<T>>((resolve, reject) => {
          this.waiters.push({ resolve, reject });
        });
      },
      return: async () => {
        this.end();
        return { done: true, value: undefined };
      },
    };
  }
}

export type UnscopedExecutionEvent = ProviderExecutionEvent extends infer E
  ? E extends ProviderExecutionEvent ? Omit<E, 'scope'> : never
  : never;

export class FakeRun implements ProviderExecutionRun {
  readonly events = new EventQueue<ProviderExecutionEvent>();
  cancelCalls = 0;
  private sequence = 0;
  holdCancellation = false;
  private readonly cancellation = deferred<void>();
  get cancelled(): Promise<void> { return this.cancellation.promise; }

  constructor(
    readonly executionId: string,
    readonly turnId: string,
    readonly sessionInstanceId = 'session-1',
  ) {}

  emit(event: UnscopedExecutionEvent): ProviderExecutionEvent {
    const scoped = { ...event, scope: {
      kind: 'requested' as const, executionId: this.executionId, turnId: this.turnId,
      sessionInstanceId: this.sessionInstanceId, sequence: ++this.sequence,
    } };
    this.events.push(scoped);
    if (['turn_completed', 'execution_error', 'cancelled'].includes(event.type)) this.events.end();
    return scoped;
  }

  complete(): void { this.emit({ type: 'turn_completed', reason: 'completed' }); }

  cancel(): void {
    this.cancelCalls += 1;
    this.cancellation.resolve();
    if (!this.holdCancellation) this.events.end();
  }
}

export class FakeSession implements ProviderExecutionSession,
  SteerableExecutionSession,
  RewindableExecutionSession {
  readonly requests: ProviderExecutionRequest[] = [];
  readonly runs: FakeRun[] = [];
  readonly steerRequests: ProviderExecutionRequest[] = [];
  readonly listeners = new Set<(event: ProviderSessionEvent) => void>();
  readonly respond = vi.fn<(run: FakeRun, request: ProviderExecutionRequest) => void>();
  private readonly runWaiters = new Set<() => void>();

  waitForRun(index = 0): Promise<FakeRun> {
    const existing = this.runs[index];
    if (existing) return Promise.resolve(existing);
    return new Promise(resolve => {
      const check = () => {
        const run = this.runs[index];
        if (!run) return;
        this.runWaiters.delete(check);
        resolve(run);
      };
      this.runWaiters.add(check);
    });
  }
  commands: SlashCommand[] | undefined;
  getCommandSnapshot() { return this.commands; }
  cancelCalls = 0;
  disposeCalls = 0;
  status: ProviderSessionStatus = 'idle';
  snapshot: ProviderSessionSnapshot;
  steerResult = true;
  readonly steerResponse = vi.fn<(request: ProviderExecutionRequest) => Promise<boolean>>(async () => this.steerResult);
  private readonly steerWaiters = new Set<() => void>();

  waitForSteer(index = 0): Promise<ProviderExecutionRequest> {
    const existing = this.steerRequests[index];
    if (existing) return Promise.resolve(existing);
    return new Promise(resolve => {
      const check = () => {
        const request = this.steerRequests[index];
        if (!request) return;
        this.steerWaiters.delete(check);
        resolve(request);
      };
      this.steerWaiters.add(check);
    });
  }
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
      this.sessionInstanceId,
    );
    this.runs.push(run);
    this.respond(run, request);
    for (const check of [...this.runWaiters]) check();
    return run;
  }

  async steer(request: ProviderExecutionRequest): Promise<boolean> {
    this.steerRequests.push(request);
    const result = this.steerResponse(request);
    for (const check of [...this.steerWaiters]) check();
    return result;
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

/** Optional native branch capability; ordinary fake sessions remain non-branchable. */
export class FakeBranchSession extends FakeSession implements BranchableExecutionSession {
  branchState: ConversationBranchState = { branches: {}, userMessageIds: {} };
  readonly getConversationBranches = vi.fn<BranchableExecutionSession['getConversationBranches']>(async () => this.branchState);
  readonly navigateConversationBranch = vi.fn<BranchableExecutionSession['navigateConversationBranch']>(async () => {
    throw new Error('Supply a native branch navigation result for this test.');
  });
  readonly reconcileConversationBranch = vi.fn<BranchableExecutionSession['reconcileConversationBranch']>(async () => {
    throw new Error('Supply a native branch recovery result for this test.');
  });
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
      linkedContent: { path: 'note.md' },
    },
    conversationHistory: [],
    configuration: {
      systemInstructions: { kind: 'main-agent' as const, instructions: 'Main Agent prompt.' },
      model: 'model-1',
    },
    toolPolicy: { kind: 'provider-default' },
    ...overrides,
  };
}

export function createExecutionPersistence(): Mocked<ChatExecutionPersistence> {
  return {
    registerExecutionBinding: vi.fn(),
    persistExecutionSnapshot: vi.fn(async () => true),
    releaseExecutionBinding: vi.fn(),
    recordConversationActivity: vi.fn(async () => undefined),
    assertConversationExecutionAuthority: vi.fn(async () => undefined),
  };
}

export function createHarness(options: {
  workingDirectory?: string;
  resolveBackend?: ChatExecutionCoordinatorDeps['resolveBackend'];
  onBackgroundWorkChanged?: (isWorking: boolean) => void;
  onError?: (error: unknown) => void;
  onRequestedEvent?: (
    event: ProviderExecutionEvent,
  ) => void | Promise<void>;
  onSessionEvent?: (
    event: ProviderSessionEvent,
    context: ChatExecutionEventContext,
  ) => void | Promise<void>;
  idleReleaseMs?: number;
  isOwnerIdle?: ChatExecutionCoordinatorDeps['isOwnerIdle'];
  onIdleRelease?: ChatExecutionCoordinatorDeps['onIdleRelease'];
  bindSessionTools?: ChatExecutionCoordinatorDeps['bindSessionTools'];
} = {}) {
  const registry = new ProviderExecutionLifecycleRegistry();
  const backends = new Map<ProviderId, FakeBackend>([
    ['claude', new FakeBackend('claude')],
    ['codex', new FakeBackend('codex')],
  ]);
  const repository = createExecutionPersistence();
  const interactionPort: Mocked<ProviderInteractionPort> = {
    requestApproval: vi.fn(async ({ interactionId }) => ({
      interactionId,
      decision: 'allow',
    })),
    askUserQuestion: vi.fn(async ({ interactionId }) => ({
      interactionId,
      answers: null,
    })),
    dismissInteraction: vi.fn(),
  };
  const requestedEvents: ProviderExecutionEvent[] = [];
  const requestedEventWaiters = new Set<() => void>();
  const waitForRequestedEvent = (matches: (event: ProviderExecutionEvent) => boolean): Promise<ProviderExecutionEvent> => {
    const existing = requestedEvents.find(matches);
    if (existing) return Promise.resolve(existing);
    return new Promise(resolve => {
      const check = () => {
        const event = requestedEvents.find(matches);
        if (!event) return;
        requestedEventWaiters.delete(check);
        resolve(event);
      };
      requestedEventWaiters.add(check);
    });
  };
  const sessionEvents: ProviderSessionEvent[] = [];
  const sessionEventContexts: ChatExecutionEventContext[] = [];
  const missingSession = vi.fn<(...args: [string, string?]) => Promise<MissingProviderSessionResolution>>(async () => 'reset');
  let nextId = 0;
  const coordinator = new ChatExecutionCoordinator({
    lifecycleRegistry: registry,
    resolveBackend: options.resolveBackend ?? ((providerId) => {
      const backend = backends.get(providerId);
      if (!backend) throw new Error(`Missing backend: ${providerId}`);
      return backend;
    }),
    persistence: repository,
    interactionPort,
    workingDirectory: options.workingDirectory ?? '/vault',
    createId: () => `local-${++nextId}`,
    onRequestedEvent: async event => {
      await options.onRequestedEvent?.(event);
      requestedEvents.push(event);
      for (const check of [...requestedEventWaiters]) check();
    },
    onSessionEvent: (event, context) => {
      sessionEvents.push(event);
      sessionEventContexts.push(context);
      return options.onSessionEvent?.(event, context);
    },
    onBackgroundWorkChanged: options.onBackgroundWorkChanged,
    onError: options.onError,
    resolveMissingProviderSession: missingSession,
    idleReleaseMs: options.idleReleaseMs,
    isOwnerIdle: options.isOwnerIdle,
    onIdleRelease: options.onIdleRelease,
    bindSessionTools: options.bindSessionTools,
  });

  return {
    registry,
    backends,
    repository,
    interactionPort,
    requestedEvents, waitForRequestedEvent,
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
  await harness.coordinator.prepare();
  const session = harness.backends.get('claude')!.sessions.at(-1)!;
  const started = session.waitForRun(session.runs.length);
  const resultPromise = harness.coordinator.execute(submission);
  const run = await started;
  return { session, run, resultPromise };
}
