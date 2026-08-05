import { ConversationRepository } from '@/app/conversations/ConversationRepository';
import type { ConversationInputLedgerReadResult } from '@/core/bootstrap/ConversationInputLedgerStorage';
import type { ConversationPersistence } from '@/core/bootstrap/ConversationPersistenceStore';
import type { SessionMetadataReader } from '@/core/bootstrap/SessionStorage';
import {
  type ModeConfigurableExecutionSession,
  type ProviderExecutionBackend,
  type ProviderExecutionEvent,
  ProviderExecutionLifecycleRegistry,
  type ProviderExecutionRequest,
  type ProviderExecutionRun,
  type ProviderExecutionSession,
  type ProviderInteractionPort,
  type ProviderSessionConfig,
  type ProviderSessionEvent,
  type ProviderSessionSnapshot,
  type ProviderSessionStatus,
  type RewindableExecutionSession,
  type SteerableExecutionSession,
} from '@/core/execution';
import type { ChatMessage, Conversation, ProviderId } from '@/core/types';
import {
  ChatExecutionCoordinator,
  type ChatExecutionCoordinatorDeps,
  type ChatExecutionEventContext,
  ChatExecutionInteractionStaleError,
  type ChatExecutionPersistence,
  ChatExecutionPreHandoffError,
  type ChatTurnSubmission,
  type MissingProviderSessionResolution,
} from '@/features/chat/execution/ChatExecutionCoordinator';
import {
  WarmExecutionCapacityError,
  type WarmExecutionOwner,
  WarmExecutionPool,
} from '@/features/chat/execution/WarmExecutionPool';

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

class FakeRun implements ProviderExecutionRun {
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

class FakeSession implements ProviderExecutionSession,
  SteerableExecutionSession,
  ModeConfigurableExecutionSession,
  RewindableExecutionSession {
  readonly requests: ProviderExecutionRequest[] = [];
  readonly runs: FakeRun[] = [];
  readonly steerRequests: ProviderExecutionRequest[] = [];
  readonly listeners = new Set<(event: ProviderSessionEvent) => void>();
  cancelCalls = 0;
  disposeCalls = 0;
  status: ProviderSessionStatus = 'idle';
  snapshot: ProviderSessionSnapshot;
  steerResult = true;
  readonly modes: string[] = [];
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

  async setMode(mode: string): Promise<boolean> {
    this.modes.push(mode);
    return true;
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

function requestedScope(
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

function createSubmission(overrides: Partial<ChatTurnSubmission> = {}): ChatTurnSubmission {
  return {
    inputRecordId: 'input-1',
    localMessageId: 'user-1',
    userTurnOrdinal: 1,
    timestamp: 123,
    rawDisplayText: 'raw input',
    canonicalText: 'canonical input',
    images: [],
    context: {
      currentNote: { path: 'note.md', content: 'note' },
      externalContextPaths: ['/external'],
    },
    conversationHistory: [],
    configuration: {
      systemInstructions: { kind: 'provider-default' },
      model: 'model-1',
      enabledMcpServers: ['server-1'],
    },
    toolPolicy: { kind: 'provider-default' },
    ...overrides,
  };
}

function createHarness(options: {
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
    stageConversationInput: jest.fn(async () => undefined),
    acceptConversationInput: jest.fn(async () => undefined),
    discardStagedConversationInput: jest.fn(async () => undefined),
    copyConversationInputsForFork: jest.fn(async () => undefined),
    truncateConversationInputsFrom: jest.fn(async () => undefined),
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
    requestPlanDecision: jest.fn(async ({ interactionId }) => ({
      interactionId,
      decision: null,
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

function deferred<T>(): {
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

async function beginExecution(
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

async function reserveProtectedWarmSlots(
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

describe('ChatExecutionCoordinator', () => {
  it('binds cold and acquires a persistent execution session only on prepare or execute', async () => {
    const harness = createHarness();

    await harness.coordinator.bindConversation({
      conversationId: 'conversation-1',
      providerId: 'claude',
      resumeSeed: { providerSessionId: 'native-session' },
    });

    expect(harness.backends.get('claude')!.sessions).toHaveLength(0);

    await harness.coordinator.prepare();

    const backend = harness.backends.get('claude')!;
    expect(backend.sessions).toHaveLength(1);
    expect(backend.configs[0]).toMatchObject({
      lifecycle: 'persistent',
      nativePersistence: 'enabled',
      resumeSeed: { providerSessionId: 'native-session' },
      vaultWorkingDirectory: '/vault',
    });
    expect(harness.repository.registerExecutionBinding).toHaveBeenCalledWith(
      'conversation-1',
      'local-1',
      0,
    );
  });

  it('does not install a provider session after the conversation changes during warm acquisition', async () => {
    const pool = new WarmExecutionPool(() => 5);
    const acquisitionGate = deferred<void>();
    const coolingOwner: WarmExecutionOwner = {
      id: 'cooling-owner',
      canCool: () => true,
      cool: jest.fn(() => acquisitionGate.promise),
    };
    await pool.acquire(coolingOwner);
    await reserveProtectedWarmSlots(pool);
    const harness = createHarness({
      warmExecution: {
        ownerId: 'preview-tab',
        pool,
        canCool: () => true,
      },
    });
    await harness.coordinator.bindConversation({
      conversationId: 'conversation-1',
      providerId: 'claude',
      resumeSeed: { providerSessionId: 'native-session-1' },
    });

    const stalePreparation = harness.coordinator.prepare();
    for (let attempt = 0;
      attempt < 20 && (coolingOwner.cool as jest.Mock).mock.calls.length === 0;
      attempt += 1) {
      await Promise.resolve();
    }
    expect(coolingOwner.cool).toHaveBeenCalledTimes(1);

    await harness.coordinator.bindConversation({
      conversationId: 'conversation-2',
      providerId: 'claude',
      resumeSeed: { providerSessionId: 'native-session-2' },
    });
    acquisitionGate.resolve(undefined);
    await stalePreparation;

    expect(harness.backends.get('claude')!.sessions).toHaveLength(0);
    expect(harness.repository.registerExecutionBinding).not.toHaveBeenCalled();
    expect(pool.has('preview-tab')).toBe(false);

    await harness.coordinator.prepare();

    expect(harness.backends.get('claude')!.configs).toEqual([
      expect.objectContaining({
        resumeSeed: { providerSessionId: 'native-session-2' },
      }),
    ]);
    expect(harness.repository.registerExecutionBinding).toHaveBeenCalledWith(
      'conversation-2',
      'local-1',
      0,
    );

    await harness.coordinator.dispose();
    await harness.registry.dispose();
  });

  it('does not resurrect a provider session after disposal during warm acquisition', async () => {
    const pool = new WarmExecutionPool(() => 5);
    const acquisitionGate = deferred<void>();
    const coolingOwner: WarmExecutionOwner = {
      id: 'cooling-owner',
      canCool: () => true,
      cool: jest.fn(() => acquisitionGate.promise),
    };
    await pool.acquire(coolingOwner);
    await reserveProtectedWarmSlots(pool);
    const harness = createHarness({
      warmExecution: {
        ownerId: 'disposed-tab',
        pool,
        canCool: () => true,
      },
    });
    await harness.coordinator.bindConversation({
      conversationId: 'conversation-1',
      providerId: 'claude',
    });

    const stalePreparation = harness.coordinator.prepare();
    for (let attempt = 0;
      attempt < 20 && (coolingOwner.cool as jest.Mock).mock.calls.length === 0;
      attempt += 1) {
      await Promise.resolve();
    }
    expect(coolingOwner.cool).toHaveBeenCalledTimes(1);

    const disposal = harness.coordinator.dispose();
    acquisitionGate.resolve(undefined);
    await Promise.all([stalePreparation, disposal]);

    expect(harness.coordinator.state).toBe('disposed');
    expect(harness.backends.get('claude')!.sessions).toHaveLength(0);
    expect(harness.repository.registerExecutionBinding).not.toHaveBeenCalled();
    expect(pool.has('disposed-tab')).toBe(false);

    await harness.registry.dispose();
  });

  it('does not publish stale warm state after rebinding during snapshot persistence', async () => {
    const pool = new WarmExecutionPool(() => 5);
    const warmStates: boolean[] = [];
    const snapshotPersistence = deferred<boolean>();
    const harness = createHarness({
      warmExecution: {
        ownerId: 'rebound-tab',
        pool,
        canCool: () => true,
        onWarmStateChanged: state => warmStates.push(state),
      },
    });
    harness.repository.persistExecutionSnapshot.mockImplementation(
      async () => snapshotPersistence.promise,
    );
    await harness.coordinator.bindConversation({
      conversationId: 'conversation-1',
      providerId: 'claude',
    });

    const stalePreparation = harness.coordinator.prepare();
    for (let attempt = 0;
      attempt < 20 && harness.repository.persistExecutionSnapshot.mock.calls.length === 0;
      attempt += 1) {
      await Promise.resolve();
    }
    expect(harness.repository.persistExecutionSnapshot).toHaveBeenCalledTimes(1);

    await harness.coordinator.bindConversation({
      conversationId: 'conversation-2',
      providerId: 'claude',
    });
    snapshotPersistence.resolve(true);
    await stalePreparation;

    expect(harness.coordinator.state).toBe('absent');
    expect(warmStates).not.toContain(true);
    expect(pool.has('rebound-tab')).toBe(false);

    await harness.coordinator.dispose();
    await harness.registry.dispose();
  });

  it('cools the least-recently-used idle coordinator without closing its tab state', async () => {
    const pool = new WarmExecutionPool(() => 5);
    await reserveProtectedWarmSlots(pool);
    const firstWarmStates: boolean[] = [];
    const secondWarmStates: boolean[] = [];
    const first = createHarness({
      warmExecution: {
        ownerId: 'first-tab',
        pool,
        canCool: () => true,
        onWarmStateChanged: state => firstWarmStates.push(state),
      },
    });
    const second = createHarness({
      warmExecution: {
        ownerId: 'second-tab',
        pool,
        canCool: () => true,
        onWarmStateChanged: state => secondWarmStates.push(state),
      },
    });

    await first.coordinator.bindConversation({
      conversationId: 'conversation-1',
      providerId: 'claude',
    });
    await first.coordinator.prepare();
    const firstSession = first.backends.get('claude')!.sessions[0];

    await second.coordinator.bindConversation({
      conversationId: 'conversation-2',
      providerId: 'claude',
    });
    await second.coordinator.prepare();

    expect(first.coordinator.state).toBe('absent');
    expect(firstSession.disposeCalls).toBe(1);
    expect(first.repository.releaseExecutionBinding).toHaveBeenCalledTimes(1);
    expect(firstWarmStates).toEqual([true, false]);
    expect(second.coordinator.state).toBe('idle');
    expect(secondWarmStates).toEqual([true]);
    expect(pool.getWarmCount()).toBe(5);

    await Promise.all([
      first.coordinator.dispose(),
      second.coordinator.dispose(),
      first.registry.dispose(),
      second.registry.dispose(),
    ]);
  });

  it('does not cool a coordinator with an active provider turn', async () => {
    const pool = new WarmExecutionPool(() => 5);
    await reserveProtectedWarmSlots(pool);
    const first = createHarness({
      warmExecution: {
        ownerId: 'first-tab',
        pool,
        canCool: () => true,
      },
    });
    const second = createHarness({
      warmExecution: {
        ownerId: 'second-tab',
        pool,
        canCool: () => true,
      },
    });
    const { resultPromise } = await beginExecution(first);
    await second.coordinator.bindConversation({
      conversationId: 'conversation-2',
      providerId: 'claude',
    });

    await expect(second.coordinator.prepare()).rejects.toEqual(
      new WarmExecutionCapacityError(5),
    );
    expect(first.coordinator.state).toBe('active');

    first.coordinator.cancel();
    await resultPromise;
    await first.coordinator.dispose();
    await second.coordinator.dispose();
    await first.registry.dispose();
    await second.registry.dispose();
  });

  it('protects a provider mode operation until its RPC settles', async () => {
    const pool = new WarmExecutionPool(() => 5);
    await reserveProtectedWarmSlots(pool);
    const first = createHarness({
      warmExecution: {
        ownerId: 'first-tab',
        pool,
        canCool: () => true,
      },
    });
    const second = createHarness({
      warmExecution: {
        ownerId: 'second-tab',
        pool,
        canCool: () => true,
      },
    });
    await first.coordinator.bindConversation({
      conversationId: 'conversation-1',
      providerId: 'claude',
    });
    await first.coordinator.prepare();
    const firstSession = first.backends.get('claude')!.sessions[0];
    const modeResult = deferred<boolean>();
    const setMode = jest.spyOn(firstSession, 'setMode')
      .mockImplementation(async () => modeResult.promise);

    const pendingModeChange = first.coordinator.setMode('plan');
    for (let attempt = 0; attempt < 20 && setMode.mock.calls.length === 0; attempt += 1) {
      await Promise.resolve();
    }
    expect(setMode).toHaveBeenCalledTimes(1);
    await second.coordinator.bindConversation({
      conversationId: 'conversation-2',
      providerId: 'claude',
    });
    let capacityError: unknown;
    try {
      await second.coordinator.prepare();
    } catch (error) {
      capacityError = error;
    }

    modeResult.resolve(true);
    const applied = await pendingModeChange;
    expect(capacityError).toEqual(new WarmExecutionCapacityError(5));
    expect(applied).toBe(true);
    expect(firstSession.disposeCalls).toBe(0);

    await first.coordinator.dispose();
    await second.coordinator.dispose();
    await first.registry.dispose();
    await second.registry.dispose();
  });

  it('protects pending background event persistence before cooling', async () => {
    const pool = new WarmExecutionPool(() => 5);
    await reserveProtectedWarmSlots(pool);
    const eventWork = deferred<void>();
    const first = createHarness({
      onSessionEvent: event => event.type === 'background_turn_completed'
        ? eventWork.promise
        : undefined,
      warmExecution: {
        ownerId: 'first-tab',
        pool,
        canCool: () => true,
      },
    });
    const second = createHarness({
      warmExecution: {
        ownerId: 'second-tab',
        pool,
        canCool: () => true,
      },
    });
    await first.coordinator.bindConversation({
      conversationId: 'conversation-1',
      providerId: 'claude',
    });
    await first.coordinator.prepare();
    const firstSession = first.backends.get('claude')!.sessions[0];
    const backgroundScope = {
      kind: 'background' as const,
      sessionInstanceId: firstSession.sessionInstanceId,
      turnId: 'background-persistence',
      sequence: 1,
    };
    firstSession.emit({ type: 'background_turn_started', scope: backgroundScope });
    firstSession.emit({
      type: 'background_turn_completed',
      scope: { ...backgroundScope, sequence: 2 },
      reason: 'completed',
    });
    await second.coordinator.bindConversation({
      conversationId: 'conversation-2',
      providerId: 'claude',
    });
    let capacityError: unknown;
    try {
      await second.coordinator.prepare();
    } catch (error) {
      capacityError = error;
    }

    expect(capacityError).toEqual(new WarmExecutionCapacityError(5));
    expect(firstSession.disposeCalls).toBe(0);

    eventWork.resolve();
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await Promise.resolve();
    }
    await second.coordinator.prepare();
    expect(firstSession.disposeCalls).toBe(1);

    await first.coordinator.dispose();
    await second.coordinator.dispose();
    await first.registry.dispose();
    await second.registry.dispose();
  });

  it('normalizes synchronous session event handler rejections to errors', async () => {
    const onError = jest.fn();
    const harness = createHarness({
      onError,
      onSessionEvent: () => {
        throw 'session event callback failed';
      },
    });
    await harness.coordinator.bindConversation({
      conversationId: 'conversation-1',
      providerId: 'claude',
    });
    await harness.coordinator.prepare();
    const session = harness.backends.get('claude')!.sessions[0];

    session.emit({
      type: 'session_error',
      category: 'provider',
      message: 'Provider event',
      recoverable: true,
      scope: {
        kind: 'session',
        sessionInstanceId: session.sessionInstanceId,
        sequence: 1,
      },
    });
    for (let attempt = 0; attempt < 20 && onError.mock.calls.length === 0; attempt += 1) {
      await Promise.resolve();
    }

    expect(onError).toHaveBeenCalledWith(expect.any(Error));
    expect((onError.mock.calls[0][0] as Error).message)
      .toBe('session event callback failed');

    await harness.coordinator.dispose();
    await harness.registry.dispose();
  });

  it('stages canonical input before execute, builds a neutral request, and accepts native IDs', async () => {
    const harness = createHarness();
    const image = {
      id: 'image-1',
      name: 'image.png',
      mediaType: 'image/png' as const,
      data: 'aGVsbG8=',
      size: 5,
      source: 'paste' as const,
    };
    const userMessage: ChatMessage = {
      id: 'user-1',
      role: 'user' as const,
      content: 'canonical input',
      timestamp: 123,
    };
    const assistantMessage: ChatMessage = {
      id: 'assistant-1',
      role: 'assistant' as const,
      content: '',
      timestamp: 124,
    };
    const submission = createSubmission({
      images: [image],
      messages: { user: userMessage, assistant: assistantMessage },
    });
    const { session, run, resultPromise } = await beginExecution(harness, submission);

    expect(harness.repository.stageConversationInput).toHaveBeenCalledTimes(1);
    expect(harness.repository.stageConversationInput.mock.calls[0][0]).toBe('conversation-1');
    expect(harness.repository.stageConversationInput.mock.calls[0][1]).toMatchObject({
      id: 'input-1',
      state: 'staged',
      rawDisplayText: 'raw input',
      canonicalText: 'canonical input',
      localMessageId: 'user-1',
      images: [image],
      context: { currentNote: { path: 'note.md', content: 'note' } },
    });
    expect(session.requests[0]).toMatchObject({
      input: [
        { type: 'text', text: 'canonical input' },
        { type: 'image', image },
      ],
      context: submission.context,
      conversationHistory: [],
      configuration: submission.configuration,
      toolPolicy: submission.toolPolicy,
    });
    expect(session.requests[0].signal).toBeInstanceOf(AbortSignal);

    run.events.push({
      type: 'turn_started',
      scope: requestedScope(session, run, 1),
      accepted: true,
      nativeUserMessageId: 'native-user',
    });
    run.events.push({
      type: 'turn_completed',
      scope: requestedScope(session, run, 2),
      reason: 'completed',
      nativeAssistantId: 'native-assistant',
      planCompleted: true,
    });
    run.events.end();

    await expect(resultPromise).resolves.toMatchObject({
      status: 'completed',
      accepted: true,
      planCompleted: true,
      nativeUserMessageId: 'native-user',
      nativeAssistantMessageId: 'native-assistant',
    });
    expect(harness.repository.acceptConversationInput).toHaveBeenNthCalledWith(
      1,
      'conversation-1',
      'input-1',
      { providerUserMessageId: 'native-user' },
    );
    expect(harness.repository.acceptConversationInput).toHaveBeenLastCalledWith(
      'conversation-1',
      'input-1',
      {
        providerUserMessageId: 'native-user',
        providerAssistantMessageId: 'native-assistant',
      },
    );
    expect(userMessage.userMessageId).toBe('native-user');
    expect(assistantMessage.assistantMessageId).toBe('native-assistant');
  });

  it('does not send staged input if the conversation switches while the ledger write is pending', async () => {
    const harness = createHarness();
    const stageBarrier = deferred<void>();
    harness.repository.stageConversationInput.mockImplementationOnce(
      async () => stageBarrier.promise,
    );
    await harness.coordinator.bindConversation({
      conversationId: 'conversation-1',
      providerId: 'claude',
    });

    const execution = harness.coordinator.execute(createSubmission());
    await Promise.resolve();
    await harness.coordinator.bindConversation({
      conversationId: 'conversation-2',
      providerId: 'codex',
    });
    stageBarrier.resolve();

    await expect(execution).rejects.toThrow('Chat execution binding changed');
    expect(harness.backends.get('claude')!.sessions).toHaveLength(0);
    expect(harness.backends.get('codex')!.sessions).toHaveLength(0);
    expect(harness.repository.discardStagedConversationInput).toHaveBeenCalledWith(
      'conversation-1',
      'input-1',
    );
  });

  it('reports a typed pre-handoff error when durable staging fails', async () => {
    const harness = createHarness();
    const cause = new Error('ledger unavailable');
    harness.repository.stageConversationInput.mockRejectedValueOnce(cause);
    await harness.coordinator.bindConversation({
      conversationId: 'conversation-1',
      providerId: 'claude',
    });

    await expect(harness.coordinator.execute(createSubmission())).rejects.toMatchObject({
      name: 'ChatExecutionPreHandoffError',
      cause,
    });
    expect(harness.backends.get('claude')!.sessions).toHaveLength(0);
    expect(harness.repository.discardStagedConversationInput).not.toHaveBeenCalled();
  });

  it('discards staging on definite pre-send failure but retains it after execute handoff', async () => {
    const harness = createHarness();
    await harness.coordinator.bindConversation({
      conversationId: 'conversation-1',
      providerId: 'claude',
    });
    await harness.coordinator.prepare();
    const session = harness.backends.get('claude')!.sessions[0];
    session.execute = jest.fn(() => {
      throw new Error('not sent');
    });

    await expect(harness.coordinator.execute(createSubmission())).rejects.toBeInstanceOf(
      ChatExecutionPreHandoffError,
    );
    expect(harness.repository.discardStagedConversationInput).toHaveBeenCalledWith(
      'conversation-1',
      'input-1',
    );

    session.execute = FakeSession.prototype.execute.bind(session);
    const resultPromise = harness.coordinator.execute(
      createSubmission({ inputRecordId: 'input-2' }),
    );
    let run: FakeRun | undefined;
    for (let attempt = 0; attempt < 20 && !run; attempt += 1) {
      await Promise.resolve();
      run = session.runs[0];
    }
    if (!run) throw new Error('Execution did not start');
    run.events.push({
      type: 'execution_error',
      scope: requestedScope(session, run, 1),
      category: 'transport',
      message: 'ambiguous',
      recoverable: true,
    });
    run.events.end();

    await expect(resultPromise).resolves.toMatchObject({
      status: 'error',
      accepted: false,
    });
    expect(harness.repository.discardStagedConversationInput).toHaveBeenCalledTimes(1);
  });

  it('discards staging after a definite asynchronous pre-handoff rejection', async () => {
    const harness = createHarness();
    const { session, run, resultPromise } = await beginExecution(
      harness,
      createSubmission({ inputRecordId: 'rejected-input' }),
    );

    run.events.push({
      type: 'turn_started',
      scope: requestedScope(session, run, 1),
      accepted: false,
    });
    const rejection: ProviderExecutionEvent = {
      type: 'execution_error',
      scope: requestedScope(session, run, 2),
      category: 'configuration',
      message: 'No enabled model is available.',
      recoverable: false,
    };
    run.events.push(rejection);
    run.events.end();

    await expect(resultPromise).rejects.toMatchObject({
      name: 'ChatExecutionPreHandoffError',
      cause: rejection,
    });
    expect(harness.repository.discardStagedConversationInput).toHaveBeenCalledWith(
      'conversation-1',
      'rejected-input',
    );
    expect(harness.repository.acceptConversationInput).not.toHaveBeenCalled();
  });

  it('discards a definite rejection before rethrowing its terminal event sink error', async () => {
    const sinkError = new Error('terminal sink failed');
    const harness = createHarness({
      onRequestedEvent: async (event) => {
        if (event.type === 'execution_error') throw sinkError;
      },
    });
    const { session, run, resultPromise } = await beginExecution(
      harness,
      createSubmission({ inputRecordId: 'sink-failure-input' }),
    );

    run.events.push({
      type: 'turn_started',
      scope: requestedScope(session, run, 1),
      accepted: false,
    });
    run.events.push({
      type: 'execution_error',
      scope: requestedScope(session, run, 2),
      category: 'configuration',
      message: 'Unsupported tool policy.',
      recoverable: false,
    });
    run.events.end();

    await expect(resultPromise).rejects.toMatchObject({
      name: 'ChatExecutionPreHandoffError',
      cause: sinkError,
    });
    expect(harness.repository.discardStagedConversationInput).toHaveBeenCalledTimes(1);
    expect(harness.repository.discardStagedConversationInput).toHaveBeenCalledWith(
      'conversation-1',
      'sink-failure-input',
    );
  });

  it('retains accepted input when a later configuration error terminates the run', async () => {
    const harness = createHarness();
    const { session, run, resultPromise } = await beginExecution(
      harness,
      createSubmission({ inputRecordId: 'accepted-input' }),
    );

    run.events.push({
      type: 'turn_started',
      scope: requestedScope(session, run, 1),
      accepted: true,
    });
    run.events.push({
      type: 'execution_error',
      scope: requestedScope(session, run, 2),
      category: 'configuration',
      message: 'Configuration changed after acceptance.',
      recoverable: true,
    });
    run.events.end();

    await expect(resultPromise).resolves.toMatchObject({
      status: 'error',
      accepted: true,
    });
    expect(harness.repository.acceptConversationInput).toHaveBeenCalledWith(
      'conversation-1',
      'accepted-input',
      { providerUserMessageId: undefined },
    );
    expect(harness.repository.discardStagedConversationInput).not.toHaveBeenCalled();
  });

  it('routes only current monotonically correlated requested events and persists snapshots', async () => {
    const harness = createHarness();
    const { session, run, resultPromise } = await beginExecution(harness);
    const snapshot: ProviderSessionSnapshot = {
      providerId: 'claude',
      revision: 2,
      providerSessionId: 'native-2',
      status: 'executing',
    };

    run.events.push({
      type: 'text_delta',
      scope: requestedScope(session, run, 1),
      text: 'accepted',
    });
    run.events.push({
      type: 'text_delta',
      scope: requestedScope(session, run, 1),
      text: 'duplicate',
    });
    run.events.push({
      type: 'text_delta',
      scope: {
        ...requestedScope(session, run, 2),
        executionId: 'stale-execution',
      },
      text: 'stale',
    });
    run.events.push({
      type: 'session_state_changed',
      scope: requestedScope(session, run, 2),
      snapshot,
    });
    run.events.push({
      type: 'turn_completed',
      scope: requestedScope(session, run, 3),
      reason: 'completed',
    });
    run.events.end();
    await resultPromise;

    expect(harness.requestedEvents.map((event) => event.type)).toEqual([
      'text_delta',
      'session_state_changed',
      'turn_completed',
    ]);
    expect(harness.repository.persistExecutionSnapshot).toHaveBeenCalledWith(
      'conversation-1',
      'local-1',
      0,
      snapshot,
    );
  });

  it('cancels only the active run and reports cancellation', async () => {
    const harness = createHarness();
    const { session, run, resultPromise } = await beginExecution(harness);

    harness.coordinator.cancel();

    expect(run.cancelCalls).toBe(1);
    expect(session.cancelCalls).toBe(0);
    expect(session.requests[0].signal.aborted).toBe(true);
    await expect(resultPromise).resolves.toMatchObject({ status: 'cancelled' });
  });

  it('stages and accepts steer input only when the current session supports and accepts it', async () => {
    const harness = createHarness();
    const { session, run, resultPromise } = await beginExecution(harness);

    await expect(harness.coordinator.steer(
      createSubmission({ inputRecordId: 'steer-1' }),
    )).resolves.toBe(true);
    expect(session.steerRequests).toHaveLength(1);
    expect(harness.repository.acceptConversationInput).toHaveBeenCalledWith(
      'conversation-1',
      'steer-1',
    );

    session.steerResult = false;
    await expect(harness.coordinator.steer(
      createSubmission({ inputRecordId: 'steer-2' }),
    )).resolves.toBe(false);
    expect(harness.repository.discardStagedConversationInput).toHaveBeenCalledWith(
      'conversation-1',
      'steer-2',
    );

    run.events.push({
      type: 'turn_completed',
      scope: requestedScope(session, run, 1),
      reason: 'completed',
    });
    run.events.end();
    await resultPromise;
  });

  it('classifies steer staging failure as definitely pre-handoff', async () => {
    const harness = createHarness();
    const { session, run, resultPromise } = await beginExecution(harness);
    const cause = new Error('steer ledger unavailable');
    harness.repository.stageConversationInput.mockRejectedValueOnce(cause);

    await expect(harness.coordinator.steer(createSubmission({
      inputRecordId: 'unstaged-steer',
    }))).rejects.toMatchObject({
      cause,
      name: 'ChatExecutionPreHandoffError',
    });

    expect(session.steerRequests).toHaveLength(0);
    expect(harness.repository.acceptConversationInput).not.toHaveBeenCalled();
    expect(harness.repository.discardStagedConversationInput).not.toHaveBeenCalled();

    run.events.push({
      type: 'turn_completed',
      scope: requestedScope(session, run, 1),
      reason: 'completed',
    });
    run.events.end();
    await resultPromise;
  });

  it('discards a rejected steer against its captured conversation after the UI binding changes', async () => {
    const harness = createHarness();
    const { session, resultPromise } = await beginExecution(harness);
    const nativeSteer = deferred<boolean>();
    const steer = jest.spyOn(session, 'steer').mockReturnValue(
      nativeSteer.promise,
    );

    const steerResult = harness.coordinator.steer(createSubmission({
      inputRecordId: 'stale-rejected-steer',
    }));
    for (let attempt = 0; attempt < 10 && steer.mock.calls.length === 0; attempt++) {
      await Promise.resolve();
    }
    expect(steer).toHaveBeenCalledTimes(1);

    await harness.coordinator.bindConversation({
      conversationId: 'conversation-2',
      providerId: 'codex',
    });
    await harness.coordinator.prepare();
    expect(harness.coordinator.snapshot?.providerId).toBe('codex');

    nativeSteer.resolve(false);

    await expect(steerResult).resolves.toBe(false);
    expect(harness.repository.discardStagedConversationInput).toHaveBeenCalledWith(
      'conversation-1',
      'stale-rejected-steer',
    );
    expect(harness.repository.acceptConversationInput).not.toHaveBeenCalled();
    expect(harness.repository.discardStagedConversationInput).not.toHaveBeenCalledWith(
      'conversation-2',
      expect.anything(),
    );
    await expect(resultPromise).resolves.toMatchObject({ status: 'invalidated' });
  });

  it('keeps definite-unsent steer classification when staged-record discard fails', async () => {
    const harness = createHarness();
    const { session, run, resultPromise } = await beginExecution(harness);
    const cleanupError = new Error('steer ledger cleanup failed');
    session.steerResult = false;
    harness.repository.discardStagedConversationInput.mockRejectedValueOnce(cleanupError);

    await expect(harness.coordinator.steer(createSubmission({
      inputRecordId: 'rejected-steer-cleanup-failed',
    }))).rejects.toMatchObject({
      cause: cleanupError,
      name: 'ChatExecutionPreHandoffError',
    });

    expect(session.steerRequests).toHaveLength(1);
    expect(harness.repository.discardStagedConversationInput).toHaveBeenCalledTimes(1);
    expect(harness.repository.discardStagedConversationInput).toHaveBeenCalledWith(
      'conversation-1',
      'rejected-steer-cleanup-failed',
    );
    expect(harness.repository.acceptConversationInput).not.toHaveBeenCalled();

    run.events.push({
      type: 'turn_completed',
      scope: requestedScope(session, run, 1),
      reason: 'completed',
    });
    run.events.end();
    await resultPromise;
  });

  it('accepts a handed-off steer against its captured conversation even when the UI binding is stale', async () => {
    const harness = createHarness();
    const { session, resultPromise } = await beginExecution(harness);
    const nativeSteer = deferred<boolean>();
    const steer = jest.spyOn(session, 'steer').mockReturnValue(
      nativeSteer.promise,
    );

    const steerResult = harness.coordinator.steer(createSubmission({
      inputRecordId: 'stale-accepted-steer',
    }));
    for (let attempt = 0; attempt < 10 && steer.mock.calls.length === 0; attempt++) {
      await Promise.resolve();
    }
    expect(steer).toHaveBeenCalledTimes(1);

    await harness.coordinator.bindConversation({
      conversationId: 'conversation-2',
      providerId: 'codex',
    });
    await harness.coordinator.prepare();
    expect(harness.coordinator.snapshot?.providerId).toBe('codex');

    nativeSteer.resolve(true);

    await expect(steerResult).resolves.toBe(true);
    expect(harness.repository.acceptConversationInput).toHaveBeenCalledWith(
      'conversation-1',
      'stale-accepted-steer',
    );
    expect(harness.repository.discardStagedConversationInput).not.toHaveBeenCalled();
    expect(harness.repository.acceptConversationInput).not.toHaveBeenCalledWith(
      'conversation-2',
      expect.anything(),
    );
    await expect(resultPromise).resolves.toMatchObject({ status: 'invalidated' });
  });

  it('retains staged steer input when provider acceptance is ambiguous', async () => {
    const harness = createHarness();
    const { session, run, resultPromise } = await beginExecution(harness);
    const steerError = new Error('steer transport closed');
    jest.spyOn(session, 'steer').mockRejectedValueOnce(steerError);

    await expect(harness.coordinator.steer(createSubmission({
      inputRecordId: 'ambiguous-steer',
    }))).rejects.toBe(steerError);

    expect(harness.repository.stageConversationInput).toHaveBeenCalledWith(
      'conversation-1',
      expect.objectContaining({ id: 'ambiguous-steer' }),
    );
    expect(harness.repository.acceptConversationInput).not.toHaveBeenCalled();
    expect(harness.repository.discardStagedConversationInput).not.toHaveBeenCalled();

    run.events.push({
      type: 'turn_completed',
      scope: requestedScope(session, run, 1),
      reason: 'completed',
    });
    run.events.end();
    await resultPromise;
  });

  it('lets an early live provider event authoritatively accept a steer before delayed false', async () => {
    const harness = createHarness();
    const { session, resultPromise } = await beginExecution(harness);
    const nativeSteer = deferred<boolean>();
    const steer = jest.spyOn(session, 'steer').mockReturnValue(nativeSteer.promise);

    const steerResult = harness.coordinator.steer(createSubmission({
      inputRecordId: 'event-before-false',
    }));
    for (let attempt = 0; attempt < 20 && steer.mock.calls.length === 0; attempt++) {
      await Promise.resolve();
    }
    expect(steer).toHaveBeenCalledTimes(1);

    await expect(harness.coordinator.acceptSteerFromProviderEvent(
      'event-before-false',
      'native-steer-user',
    )).resolves.toBe(true);
    nativeSteer.resolve(false);

    await expect(steerResult).resolves.toBe(true);
    expect(harness.repository.acceptConversationInput).toHaveBeenCalledTimes(1);
    expect(harness.repository.acceptConversationInput).toHaveBeenCalledWith(
      'conversation-1',
      'event-before-false',
      { providerUserMessageId: 'native-steer-user' },
    );
    expect(harness.repository.discardStagedConversationInput).not.toHaveBeenCalled();

    await harness.coordinator.bindConversation(null);
    await expect(resultPromise).resolves.toMatchObject({ status: 'invalidated' });
  });

  it('keeps event-before-true acceptance correlated and idempotent', async () => {
    const harness = createHarness();
    const { session, resultPromise } = await beginExecution(harness);
    const nativeSteer = deferred<boolean>();
    const steer = jest.spyOn(session, 'steer').mockReturnValue(nativeSteer.promise);

    const steerResult = harness.coordinator.steer(createSubmission({
      inputRecordId: 'event-before-true',
    }));
    for (let attempt = 0; attempt < 20 && steer.mock.calls.length === 0; attempt++) {
      await Promise.resolve();
    }

    await expect(harness.coordinator.acceptSteerFromProviderEvent(
      'event-before-true',
      'native-event-first',
    )).resolves.toBe(true);
    nativeSteer.resolve(true);

    await expect(steerResult).resolves.toBe(true);
    expect(harness.repository.acceptConversationInput).toHaveBeenCalledTimes(1);
    expect(harness.repository.acceptConversationInput).toHaveBeenCalledWith(
      'conversation-1',
      'event-before-true',
      { providerUserMessageId: 'native-event-first' },
    );
    await expect(harness.coordinator.acceptSteerFromProviderEvent(
      'event-before-true',
      'native-event-first',
    )).resolves.toBe(false);

    await harness.coordinator.bindConversation(null);
    await expect(resultPromise).resolves.toMatchObject({ status: 'invalidated' });
  });

  it('enriches an acknowledged steer with the later exact native user ID once', async () => {
    const harness = createHarness();
    const { session, run, resultPromise } = await beginExecution(harness);
    jest.spyOn(session, 'steer').mockResolvedValueOnce(true);

    await expect(harness.coordinator.steer(createSubmission({
      inputRecordId: 'ack-before-event',
    }))).resolves.toBe(true);
    expect(harness.repository.acceptConversationInput).toHaveBeenCalledTimes(1);
    expect(harness.repository.acceptConversationInput).toHaveBeenLastCalledWith(
      'conversation-1',
      'ack-before-event',
    );

    await expect(harness.coordinator.acceptSteerFromProviderEvent(
      'ack-before-event',
      'native-user-after-ack',
    )).resolves.toBe(true);
    expect(harness.repository.acceptConversationInput).toHaveBeenCalledTimes(2);
    expect(harness.repository.acceptConversationInput).toHaveBeenLastCalledWith(
      'conversation-1',
      'ack-before-event',
      { providerUserMessageId: 'native-user-after-ack' },
    );
    await expect(harness.coordinator.acceptSteerFromProviderEvent(
      'ack-before-event',
      'native-user-after-ack',
    )).resolves.toBe(false);
    expect(harness.repository.acceptConversationInput).toHaveBeenCalledTimes(2);

    run.events.push({
      type: 'turn_completed',
      scope: requestedScope(session, run, 1),
      reason: 'completed',
    });
    run.events.end();
    await resultPromise;
  });

  it('serializes native-ID enrichment behind a pending ID-less acceptance save', async () => {
    const harness = createHarness();
    const { session, run, resultPromise } = await beginExecution(harness);
    const baseAcceptance = deferred<void>();
    const enrichment = deferred<void>();
    jest.spyOn(session, 'steer').mockResolvedValueOnce(true);
    harness.repository.acceptConversationInput
      .mockImplementationOnce(() => baseAcceptance.promise)
      .mockImplementationOnce(() => enrichment.promise);

    const steerResult = harness.coordinator.steer(createSubmission({
      inputRecordId: 'pending-ack-before-event',
    }));
    for (
      let attempt = 0;
      attempt < 20 && harness.repository.acceptConversationInput.mock.calls.length === 0;
      attempt++
    ) {
      await Promise.resolve();
    }
    const liveAcceptance = harness.coordinator.acceptSteerFromProviderEvent(
      'pending-ack-before-event',
      'native-during-save',
    );

    expect(harness.repository.acceptConversationInput).toHaveBeenCalledTimes(1);
    baseAcceptance.resolve();
    await expect(steerResult).resolves.toBe(true);
    for (
      let attempt = 0;
      attempt < 20 && harness.repository.acceptConversationInput.mock.calls.length < 2;
      attempt++
    ) {
      await Promise.resolve();
    }
    expect(harness.repository.acceptConversationInput).toHaveBeenLastCalledWith(
      'conversation-1',
      'pending-ack-before-event',
      { providerUserMessageId: 'native-during-save' },
    );
    enrichment.resolve();
    await expect(liveAcceptance).resolves.toBe(true);
    expect(harness.repository.acceptConversationInput).toHaveBeenCalledTimes(2);

    run.events.push({
      type: 'turn_completed',
      scope: requestedScope(session, run, 1),
      reason: 'completed',
    });
    run.events.end();
    await resultPromise;
  });

  it('retries exact native-ID acceptance after the ID-less save rejects', async () => {
    const harness = createHarness();
    const { session, run, resultPromise } = await beginExecution(harness);
    const baseFailure = new Error('ID-less acceptance save failed');
    jest.spyOn(session, 'steer').mockResolvedValueOnce(true);
    harness.repository.acceptConversationInput
      .mockRejectedValueOnce(baseFailure)
      .mockResolvedValueOnce(undefined);

    await expect(harness.coordinator.steer(createSubmission({
      inputRecordId: 'ack-save-failed-before-event',
    }))).rejects.toBe(baseFailure);
    await expect(harness.coordinator.acceptSteerFromProviderEvent(
      'ack-save-failed-before-event',
      'native-after-save-failure',
    )).resolves.toBe(true);

    expect(harness.repository.acceptConversationInput).toHaveBeenCalledTimes(2);
    expect(harness.repository.acceptConversationInput).toHaveBeenLastCalledWith(
      'conversation-1',
      'ack-save-failed-before-event',
      { providerUserMessageId: 'native-after-save-failure' },
    );
    await expect(harness.coordinator.acceptSteerFromProviderEvent(
      'ack-save-failed-before-event',
      'native-after-save-failure',
    )).resolves.toBe(false);

    run.events.push({
      type: 'turn_completed',
      scope: requestedScope(session, run, 1),
      reason: 'completed',
    });
    run.events.end();
    await resultPromise;
  });

  it('surfaces native-ID enrichment failure after suppressing the earlier ID-less save error', async () => {
    const harness = createHarness();
    const { session, run, resultPromise } = await beginExecution(harness);
    const baseFailure = new Error('ID-less acceptance save failed');
    const enrichmentFailure = new Error('native-ID enrichment failed');
    jest.spyOn(session, 'steer').mockResolvedValueOnce(true);
    harness.repository.acceptConversationInput
      .mockRejectedValueOnce(baseFailure)
      .mockRejectedValueOnce(enrichmentFailure);

    await expect(harness.coordinator.steer(createSubmission({
      inputRecordId: 'both-acceptance-saves-failed',
    }))).rejects.toBe(baseFailure);
    await expect(harness.coordinator.acceptSteerFromProviderEvent(
      'both-acceptance-saves-failed',
      'native-after-both-failures',
    )).rejects.toBe(enrichmentFailure);
    await expect(harness.coordinator.acceptSteerFromProviderEvent(
      'both-acceptance-saves-failed',
      'native-after-both-failures',
    )).resolves.toBe(false);
    expect(harness.repository.acceptConversationInput).toHaveBeenCalledTimes(2);

    run.events.push({
      type: 'turn_completed',
      scope: requestedScope(session, run, 1),
      reason: 'completed',
    });
    run.events.end();
    await resultPromise;
  });

  it.each(['bind', 'invalidation', 'dispose'] as const)(
    'clears retained acknowledged steer correlation on %s',
    async (boundary) => {
      const harness = createHarness();
      const { session, resultPromise } = await beginExecution(harness);
      jest.spyOn(session, 'steer').mockResolvedValueOnce(true);

      await expect(harness.coordinator.steer(createSubmission({
        inputRecordId: `accepted-before-${boundary}`,
      }))).resolves.toBe(true);
      if (boundary === 'bind') {
        await harness.coordinator.bindConversation({
          conversationId: 'conversation-2',
          providerId: 'codex',
        });
      } else if (boundary === 'invalidation') {
        await harness.registry.runTransition(['claude'], async () => undefined);
      } else {
        await harness.coordinator.dispose();
      }

      await expect(harness.coordinator.acceptSteerFromProviderEvent(
        `accepted-before-${boundary}`,
        `native-after-${boundary}`,
      )).resolves.toBe(false);
      expect(harness.repository.acceptConversationInput).toHaveBeenCalledTimes(1);
      await expect(resultPromise).resolves.toMatchObject({ status: 'invalidated' });
    },
  );

  it('drops acknowledged correlation when terminal history delegation sees no live event', async () => {
    const harness = createHarness();
    const { session, run, resultPromise } = await beginExecution(harness);
    jest.spyOn(session, 'steer').mockResolvedValueOnce(true);

    await expect(harness.coordinator.steer(createSubmission({
      inputRecordId: 'accepted-without-event',
    }))).resolves.toBe(true);
    harness.coordinator.releaseSteerCorrelation('accepted-without-event');

    await expect(harness.coordinator.acceptSteerFromProviderEvent(
      'accepted-without-event',
      'too-late-native-user',
    )).resolves.toBe(false);
    expect(harness.repository.acceptConversationInput).toHaveBeenCalledTimes(1);

    run.events.push({
      type: 'turn_completed',
      scope: requestedScope(session, run, 1),
      reason: 'completed',
    });
    run.events.end();
    await resultPromise;
  });

  it('lets an early live provider event authoritatively accept a steer before delayed error', async () => {
    const harness = createHarness();
    const { session, resultPromise } = await beginExecution(harness);
    const nativeSteer = deferred<boolean>();
    const steer = jest.spyOn(session, 'steer').mockReturnValue(nativeSteer.promise);

    const steerResult = harness.coordinator.steer(createSubmission({
      inputRecordId: 'event-before-error',
    }));
    for (let attempt = 0; attempt < 20 && steer.mock.calls.length === 0; attempt++) {
      await Promise.resolve();
    }
    await expect(harness.coordinator.acceptSteerFromProviderEvent(
      'event-before-error',
    )).resolves.toBe(true);
    await harness.coordinator.bindConversation({
      conversationId: 'conversation-2',
      providerId: 'codex',
    });
    nativeSteer.reject(new Error('late transport failure'));

    await expect(steerResult).resolves.toBe(true);
    expect(harness.repository.acceptConversationInput).toHaveBeenCalledWith(
      'conversation-1',
      'event-before-error',
    );
    expect(harness.repository.discardStagedConversationInput).not.toHaveBeenCalled();
    await expect(resultPromise).resolves.toMatchObject({ status: 'invalidated' });
  });

  it('persists early live steer acceptance even when the native result never settles', async () => {
    const harness = createHarness();
    const { session, run, resultPromise } = await beginExecution(harness);
    const nativeSteer = deferred<boolean>();
    const steer = jest.spyOn(session, 'steer').mockReturnValue(nativeSteer.promise);

    void harness.coordinator.steer(createSubmission({
      inputRecordId: 'event-before-never',
    }));
    for (let attempt = 0; attempt < 20 && steer.mock.calls.length === 0; attempt++) {
      await Promise.resolve();
    }

    await expect(harness.coordinator.acceptSteerFromProviderEvent(
      'event-before-never',
      'native-never-user',
    )).resolves.toBe(true);
    expect(harness.repository.acceptConversationInput).toHaveBeenCalledWith(
      'conversation-1',
      'event-before-never',
      { providerUserMessageId: 'native-never-user' },
    );
    expect(harness.repository.discardStagedConversationInput).not.toHaveBeenCalled();
    await expect(harness.coordinator.acceptSteerFromProviderEvent(
      'event-before-never',
    )).resolves.toBe(false);

    run.events.push({
      type: 'turn_completed',
      scope: requestedScope(session, run, 1),
      reason: 'completed',
    });
    run.events.end();
    await resultPromise;
  });

  it('upgrades an ambiguous native steer result when its exact live event arrives later', async () => {
    const harness = createHarness();
    const { session, run, resultPromise } = await beginExecution(harness);
    jest.spyOn(session, 'steer').mockRejectedValueOnce(new Error('acknowledgement lost'));

    await expect(harness.coordinator.steer(createSubmission({
      inputRecordId: 'event-after-error',
    }))).rejects.toThrow('acknowledgement lost');

    await expect(harness.coordinator.acceptSteerFromProviderEvent(
      'event-after-error',
      'native-late-user',
    )).resolves.toBe(true);
    expect(harness.repository.acceptConversationInput).toHaveBeenCalledWith(
      'conversation-1',
      'event-after-error',
      { providerUserMessageId: 'native-late-user' },
    );
    expect(harness.repository.discardStagedConversationInput).not.toHaveBeenCalled();
    await expect(harness.coordinator.acceptSteerFromProviderEvent(
      'event-after-error',
    )).resolves.toBe(false);

    run.events.push({
      type: 'turn_completed',
      scope: requestedScope(session, run, 1),
      reason: 'completed',
    });
    run.events.end();
    await resultPromise;
  });

  it('drops ambiguous in-memory correlation when durable history takes ownership', async () => {
    const harness = createHarness();
    const { session, run, resultPromise } = await beginExecution(harness);
    jest.spyOn(session, 'steer').mockRejectedValueOnce(new Error('acknowledgement lost'));

    await expect(harness.coordinator.steer(createSubmission({
      inputRecordId: 'delegated-ambiguous',
    }))).rejects.toThrow('acknowledgement lost');
    harness.coordinator.releaseSteerCorrelation('delegated-ambiguous');

    await expect(harness.coordinator.acceptSteerFromProviderEvent(
      'delegated-ambiguous',
      'too-late-user',
    )).resolves.toBe(false);
    expect(harness.repository.acceptConversationInput).not.toHaveBeenCalled();

    run.events.push({
      type: 'turn_completed',
      scope: requestedScope(session, run, 1),
      reason: 'completed',
    });
    run.events.end();
    await resultPromise;
  });

  it('does not leak event correlation when live acceptance persistence fails', async () => {
    const harness = createHarness();
    const { session, run, resultPromise } = await beginExecution(harness);
    const nativeSteer = deferred<boolean>();
    const steer = jest.spyOn(session, 'steer').mockReturnValue(nativeSteer.promise);
    harness.repository.acceptConversationInput.mockRejectedValueOnce(
      new Error('accept save failed'),
    );

    void harness.coordinator.steer(createSubmission({
      inputRecordId: 'accept-save-failure',
    })).catch(() => {});
    for (let attempt = 0; attempt < 20 && steer.mock.calls.length === 0; attempt++) {
      await Promise.resolve();
    }

    await expect(harness.coordinator.acceptSteerFromProviderEvent(
      'accept-save-failure',
      'native-accepted-user',
    )).rejects.toThrow('accept save failed');
    await expect(harness.coordinator.acceptSteerFromProviderEvent(
      'accept-save-failure',
    )).resolves.toBe(false);
    expect(harness.repository.discardStagedConversationInput).not.toHaveBeenCalled();

    run.events.push({
      type: 'turn_completed',
      scope: requestedScope(session, run, 1),
      reason: 'completed',
    });
    run.events.end();
    await resultPromise;
  });

  it('routes correlated background turns, persists their snapshots, and rejects stale output', async () => {
    const harness = createHarness();
    await harness.coordinator.bindConversation({
      conversationId: 'conversation-1',
      providerId: 'claude',
    });
    await harness.coordinator.prepare();
    const session = harness.backends.get('claude')!.sessions[0];
    const backgroundScope = {
      kind: 'background' as const,
      sessionInstanceId: session.sessionInstanceId,
      turnId: 'background-1',
      sequence: 1,
    };
    const snapshot: ProviderSessionSnapshot = {
      providerId: 'claude',
      revision: 3,
      status: 'idle',
      providerSessionId: 'native-background',
    };

    session.emit({ type: 'background_turn_started', scope: backgroundScope });
    session.emit({
      type: 'text_delta',
      scope: { ...backgroundScope, sequence: 2 },
      text: 'background',
    });
    session.emit({
      type: 'session_state_changed',
      scope: { ...backgroundScope, sequence: 3 },
      snapshot,
    });
    session.emit({
      type: 'background_turn_completed',
      scope: { ...backgroundScope, sequence: 4 },
      reason: 'completed',
    });
    session.emit({
      type: 'text_delta',
      scope: { ...backgroundScope, sequence: 5 },
      text: 'late',
    });
    await Promise.resolve();

    expect(harness.sessionEvents.map((event) => event.type)).toEqual([
      'background_turn_started',
      'text_delta',
      'session_state_changed',
      'background_turn_completed',
    ]);
    expect(harness.repository.persistExecutionSnapshot).toHaveBeenCalledWith(
      'conversation-1',
      'local-1',
      0,
      snapshot,
    );
  });

  it('exposes session-event context validity and fences it before binding release awaits', async () => {
    const harness = createHarness();
    await harness.coordinator.bindConversation({
      conversationId: 'conversation-1',
      providerId: 'claude',
    });
    await harness.coordinator.prepare();
    const session = harness.backends.get('claude')!.sessions[0];

    session.emit({
      type: 'session_error',
      category: 'provider',
      message: 'background failure',
      recoverable: true,
      scope: {
        kind: 'session',
        sessionInstanceId: session.sessionInstanceId,
        sequence: 1,
      },
    });

    const [context] = harness.sessionEventContexts;
    expect(context).toBeDefined();
    expect(harness.coordinator.isEventContextCurrent(context)).toBe(true);

    const switchPromise = harness.coordinator.bindConversation({
      conversationId: 'conversation-2',
      providerId: 'codex',
    });

    expect(harness.coordinator.isEventContextCurrent(context)).toBe(false);
    await switchPromise;
    expect(harness.coordinator.isEventContextCurrent(context)).toBe(false);

    await harness.coordinator.prepare();
    const replacementSession = harness.backends.get('codex')!.sessions[0];
    replacementSession.emit({
      type: 'session_error',
      category: 'provider',
      message: 'replacement failure',
      recoverable: true,
      scope: {
        kind: 'session',
        sessionInstanceId: replacementSession.sessionInstanceId,
        sequence: 1,
      },
    });
    const replacementContext = harness.sessionEventContexts[1];
    expect(harness.coordinator.isEventContextCurrent(replacementContext)).toBe(true);

    const transition = harness.registry.runTransition(['codex'], async () => undefined);
    for (
      let attempt = 0;
      attempt < 10 && harness.coordinator.isEventContextCurrent(replacementContext);
      attempt++
    ) {
      await Promise.resolve();
    }
    expect(harness.coordinator.isEventContextCurrent(replacementContext)).toBe(false);
    await transition;
  });

  it('fences interaction requests by current session and active turn identity', async () => {
    const harness = createHarness();
    const { session, run, resultPromise } = await beginExecution(harness);
    const port = harness.backends.get('claude')!.configs[0].interactionPort;

    await expect(port.requestApproval({
      kind: 'approval',
      interactionId: 'approval-1',
      sessionInstanceId: session.sessionInstanceId,
      turnId: run.turnId,
      toolName: 'Read',
      input: {},
      description: 'Read a file',
    }, new AbortController().signal)).resolves.toMatchObject({
      interactionId: 'approval-1',
    });
    await expect(port.askUserQuestion({
      kind: 'question',
      interactionId: 'question-stale',
      sessionInstanceId: session.sessionInstanceId,
      turnId: 'other-turn',
      input: {},
    }, new AbortController().signal)).rejects.toBeInstanceOf(
      ChatExecutionInteractionStaleError,
    );
    expect(harness.interactionPort.askUserQuestion).not.toHaveBeenCalled();

    run.events.push({
      type: 'turn_completed',
      scope: requestedScope(session, run, 1),
      reason: 'completed',
    });
    run.events.end();
    await resultPromise;
  });

  it('switches provider/conversation by immediately fencing and then releasing the old binding', async () => {
    const harness = createHarness();
    const { session, run, resultPromise } = await beginExecution(harness);

    await harness.coordinator.bindConversation({
      conversationId: 'conversation-2',
      providerId: 'codex',
    });
    run.events.push({
      type: 'text_delta',
      scope: requestedScope(session, run, 1),
      text: 'late',
    });
    run.events.end();

    await expect(resultPromise).resolves.toMatchObject({ status: 'invalidated' });
    expect(session.disposeCalls).toBe(1);
    expect(harness.repository.releaseExecutionBinding).toHaveBeenCalledWith(
      'conversation-1',
      'local-1',
    );
    expect(harness.requestedEvents).toHaveLength(0);

    await harness.coordinator.prepare();
    expect(harness.backends.get('codex')!.sessions).toHaveLength(1);
  });

  it('publishes a null binding before rejected lease release and cannot reacquire', async () => {
    const harness = createHarness();
    await harness.coordinator.bindConversation({
      conversationId: 'conversation-1',
      providerId: 'claude',
    });
    await harness.coordinator.prepare();
    const backend = harness.backends.get('claude')!;
    const session = backend.sessions[0];
    const disposeError = new Error('provider cleanup failed');
    jest.spyOn(session, 'dispose').mockImplementationOnce(async () => {
      session.disposeCalls += 1;
      session.status = 'disposed';
      throw disposeError;
    });

    await expect(harness.coordinator.bindConversation(null)).rejects.toBe(
      disposeError,
    );

    const reacquire = jest.spyOn(backend, 'createSession').mockImplementationOnce(() => {
      throw new Error('provider was reacquired');
    });
    await expect(harness.coordinator.execute(createSubmission())).rejects.toThrow(
      'No conversation is bound for chat execution',
    );
    expect(reacquire).not.toHaveBeenCalled();
    expect(harness.repository.stageConversationInput).not.toHaveBeenCalled();
    expect(session.disposeCalls).toBe(1);
    expect(session.requests).toHaveLength(0);
  });

  it('does not hand off a durably deleted turn when held ledger loading meets rejected disposal', async () => {
    const ledgerLoad = deferred<ConversationInputLedgerReadResult>();
    let tombstoned = false;
    let currentMetadataExists = true;
    let inputLedgerExists = true;
    const storage = {
      metadataReader: {
        load: jest.fn(),
        scan: jest.fn(),
        loadMetadata: jest.fn(),
        scanMetadata: jest.fn(),
        listMetadata: jest.fn(),
      } as unknown as SessionMetadataReader,
      loadInputLedger: jest.fn(() => ledgerLoad.promise),
      saveInputLedger: jest.fn(async () => undefined),
      saveMetadata: jest.fn(async () => undefined),
      deleteCurrentMetadata: jest.fn(async () => {
        currentMetadataExists = false;
      }),
      deleteLegacyMetadata: jest.fn(async () => undefined),
      deleteInputLedger: jest.fn(async () => {
        inputLedgerExists = false;
      }),
      isDeleted: jest.fn(async () => tombstoned),
      markDeleted: jest.fn(async () => {
        tombstoned = true;
      }),
    } as unknown as ConversationPersistence;
    const conversation: Conversation = {
      id: 'conversation-1',
      providerId: 'claude',
      title: 'Conversation',
      createdAt: 1,
      lastActivityAt: 1,
      sessionId: null,
      messages: [],
    };
    const registry = new ProviderExecutionLifecycleRegistry();
    const backend = new FakeBackend('claude');
    const coordinatorOwner: { current: ChatExecutionCoordinator | null } = {
      current: null,
    };
    const repository = new ConversationRepository({
      getSettings: () => ({}),
      getVaultPath: () => '/vault',
      persistence: storage,
      onConversationDeleted: async () => {
        if (!coordinatorOwner.current) {
          throw new Error('Coordinator is not initialized');
        }
        await coordinatorOwner.current.bindConversation(null);
      },
    });
    repository.replaceAll([conversation]);
    const coordinatorPersistence: ChatExecutionPersistence = {
      registerExecutionBinding: (...args) => {
        repository.registerExecutionBinding(...args);
      },
      persistExecutionSnapshot: async () => true,
      releaseExecutionBinding: (...args) => {
        repository.releaseExecutionBinding(...args);
      },
      stageConversationInput: (...args) => repository.stageConversationInput(...args),
      acceptConversationInput: (...args) => repository.acceptConversationInput(...args),
      discardStagedConversationInput: (...args) => (
        repository.discardStagedConversationInput(...args)
      ),
      copyConversationInputsForFork: (...args) => (
        repository.copyConversationInputsForFork(...args)
      ),
      truncateConversationInputsFrom: (...args) => (
        repository.truncateConversationInputsFrom(...args)
      ),
    };
    const interactionPort = {
      requestApproval: jest.fn(),
      askUserQuestion: jest.fn(),
      requestPlanDecision: jest.fn(),
      dismissInteraction: jest.fn(),
    } as unknown as ProviderInteractionPort;
    const coordinator = new ChatExecutionCoordinator({
      lifecycleRegistry: registry,
      resolveBackend: () => backend,
      persistence: coordinatorPersistence,
      interactionPort,
      vaultWorkingDirectory: '/vault',
      createId: (() => {
        let nextId = 0;
        return () => `integrated-${++nextId}`;
      })(),
      resolveMissingProviderSession: async () => 'reset',
    });
    coordinatorOwner.current = coordinator;
    await coordinator.bindConversation({
      conversationId: conversation.id,
      providerId: conversation.providerId,
    });
    await coordinator.prepare();
    const session = backend.sessions[0];
    const disposeError = new Error('provider cleanup failed');
    jest.spyOn(session, 'dispose').mockRejectedValueOnce(disposeError);

    const send = coordinator.execute(createSubmission());
    for (
      let attempt = 0;
      attempt < 20 && (storage.loadInputLedger as jest.Mock).mock.calls.length === 0;
      attempt += 1
    ) {
      await Promise.resolve();
    }
    expect(storage.loadInputLedger).toHaveBeenCalledTimes(1);

    await expect(repository.delete(conversation.id)).rejects.toBe(disposeError);
    ledgerLoad.resolve({ status: 'missing' });

    await expect(send).rejects.toBeInstanceOf(ChatExecutionPreHandoffError);
    expect(backend.sessions).toHaveLength(1);
    expect(session.requests).toHaveLength(0);
    expect(storage.saveInputLedger).not.toHaveBeenCalled();
    expect(storage.deleteCurrentMetadata).toHaveBeenCalledWith(conversation.id);
    expect(storage.deleteInputLedger).toHaveBeenCalledWith(conversation.id);
    expect(tombstoned).toBe(true);
    expect(currentMetadataExists).toBe(false);
    expect(inputLedgerExists).toBe(false);
    expect(repository.getCachedConversation(conversation.id)).toBeNull();
  });

  it('handles missing provider sessions through the injected history boundary and releases the lease', async () => {
    const harness = createHarness();
    const { session, run, resultPromise } = await beginExecution(harness);
    run.events.push({
      type: 'execution_error',
      scope: requestedScope(session, run, 1),
      category: 'provider-session-missing',
      message: 'missing',
      recoverable: true,
      missingProviderSessionId: 'missing-native',
    });
    run.events.end();

    await expect(resultPromise).resolves.toMatchObject({
      status: 'missing-session',
      missingSessionResolution: 'reset',
    });
    expect(harness.missingSession).toHaveBeenCalledWith(
      'conversation-1',
      'missing-native',
    );
    expect(harness.repository.discardStagedConversationInput).toHaveBeenCalledWith(
      'conversation-1',
      'input-1',
    );
    expect(session.disposeCalls).toBe(1);

    await harness.coordinator.prepare();
    const backend = harness.backends.get('claude')!;
    expect(backend.sessions).toHaveLength(2);
    expect(backend.configs[1]?.resumeSeed).toBeUndefined();
  });

  it('clears the conversation binding after missing-session deletion', async () => {
    const harness = createHarness();
    harness.missingSession.mockResolvedValueOnce('deleted');
    const { session, run, resultPromise } = await beginExecution(harness);
    run.events.push({
      type: 'execution_error',
      scope: requestedScope(session, run, 1),
      category: 'provider-session-missing',
      message: 'missing',
      recoverable: true,
      missingProviderSessionId: 'missing-native',
    });
    run.events.end();

    await expect(resultPromise).resolves.toMatchObject({
      status: 'missing-session',
      accepted: false,
      missingSessionResolution: 'deleted',
    });
    expect(harness.repository.discardStagedConversationInput).toHaveBeenCalledWith(
      'conversation-1',
      'input-1',
    );
    expect(session.disposeCalls).toBe(1);
    await expect(harness.coordinator.prepare()).rejects.toThrow(
      'No conversation is bound for chat execution',
    );
  });

  it('does not apply a late missing-session reset to a replacement binding', async () => {
    const harness = createHarness();
    const resolution = deferred<'reset'>();
    harness.missingSession.mockReturnValueOnce(resolution.promise);
    const { session, run, resultPromise } = await beginExecution(harness);
    run.events.push({
      type: 'execution_error',
      scope: requestedScope(session, run, 1),
      category: 'provider-session-missing',
      message: 'missing',
      recoverable: true,
      missingProviderSessionId: 'missing-native',
    });
    run.events.end();
    for (
      let attempt = 0;
      attempt < 20 && harness.missingSession.mock.calls.length === 0;
      attempt += 1
    ) {
      await Promise.resolve();
    }

    await harness.coordinator.bindConversation({
      conversationId: 'conversation-2',
      providerId: 'codex',
      resumeSeed: { providerSessionId: 'codex-native' },
    });
    resolution.resolve('reset');

    await expect(resultPromise).resolves.toMatchObject({
      status: 'invalidated',
      accepted: false,
    });
    await harness.coordinator.prepare();
    expect(harness.backends.get('codex')!.configs[0]?.resumeSeed).toEqual({
      providerSessionId: 'codex-native',
    });
    expect(harness.backends.get('claude')!.sessions).toHaveLength(1);
    expect(session.disposeCalls).toBe(1);
  });

  it('retains accepted input when the provider reports its session missing', async () => {
    const harness = createHarness();
    const { session, run, resultPromise } = await beginExecution(
      harness,
      createSubmission({ inputRecordId: 'accepted-missing-input' }),
    );
    run.events.push({
      type: 'turn_started',
      scope: requestedScope(session, run, 1),
      accepted: true,
    });
    run.events.push({
      type: 'execution_error',
      scope: requestedScope(session, run, 2),
      category: 'provider-session-missing',
      message: 'missing after handoff',
      recoverable: true,
      missingProviderSessionId: 'missing-native',
    });
    run.events.end();

    await expect(resultPromise).resolves.toMatchObject({
      status: 'missing-session',
      accepted: true,
    });
    expect(harness.repository.acceptConversationInput).toHaveBeenCalledWith(
      'conversation-1',
      'accepted-missing-input',
      { providerUserMessageId: undefined },
    );
    expect(harness.repository.discardStagedConversationInput).not.toHaveBeenCalled();
  });

  it('recovers an unaccepted missing session before surfacing a retryable terminal sink failure', async () => {
    const sinkError = new Error('missing-session sink failed');
    const harness = createHarness({
      onRequestedEvent: async (event) => {
        if (event.type === 'execution_error') throw sinkError;
      },
    });
    const { session, run, resultPromise } = await beginExecution(
      harness,
      createSubmission({ inputRecordId: 'missing-sink-input' }),
    );
    run.events.push({
      type: 'execution_error',
      scope: requestedScope(session, run, 1),
      category: 'provider-session-missing',
      message: 'missing',
      recoverable: true,
      missingProviderSessionId: 'missing-native',
    });
    run.events.end();

    await expect(resultPromise).rejects.toMatchObject({
      name: 'ChatExecutionPreHandoffError',
      cause: sinkError,
    });
    expect(harness.repository.discardStagedConversationInput).toHaveBeenCalledWith(
      'conversation-1',
      'missing-sink-input',
    );
    expect(harness.missingSession).toHaveBeenCalledWith(
      'conversation-1',
      'missing-native',
    );
    expect(session.disposeCalls).toBe(1);
  });

  it('routes rewind and fork helpers without reconstructing provider state in the feature', async () => {
    const harness = createHarness();
    await harness.coordinator.bindConversation({
      conversationId: 'conversation-1',
      providerId: 'claude',
    });
    await harness.coordinator.prepare();
    const session = harness.backends.get('claude')!.sessions[0];
    session.snapshot = {
      providerId: 'claude',
      revision: 4,
      status: 'idle',
      providerSessionId: 'native-current',
    };

    await expect(harness.coordinator.previewRewind(
      'user-1',
      'assistant-1',
      'conversation',
    )).resolves.toEqual({ canRewind: true });
    await expect(harness.coordinator.rewind(
      'user-1',
      'assistant-1',
      'conversation',
    )).resolves.toMatchObject({ canRewind: true });
    expect(harness.repository.truncateConversationInputsFrom).toHaveBeenCalledWith(
      'conversation-1',
      'user-1',
    );

    await expect(harness.coordinator.resolveForkSource(
      'assistant-1',
      async () => 'native-fallback',
    )).resolves.toEqual({
      sessionId: 'native-current',
      resumeAt: 'assistant-1',
    });
    await harness.coordinator.copyInputsForFork('conversation-2', 'assistant-1');
    expect(harness.repository.copyConversationInputsForFork).toHaveBeenCalledWith(
      'conversation-1',
      'conversation-2',
      'assistant-1',
    );
  });

  it('truncates the captured conversation ledger after native rewind succeeds on a stale binding', async () => {
    const harness = createHarness();
    await harness.coordinator.bindConversation({
      conversationId: 'conversation-1',
      providerId: 'claude',
    });
    await harness.coordinator.prepare();
    const session = harness.backends.get('claude')!.sessions[0];
    const nativeRewind = deferred<typeof session.rewindResult>();
    const rewind = jest.spyOn(session, 'rewind').mockReturnValue(nativeRewind.promise);

    const resultPromise = harness.coordinator.rewind(
      'user-before-transition',
      'assistant-before-transition',
      'conversation',
    );
    for (let attempt = 0; attempt < 10 && rewind.mock.calls.length === 0; attempt++) {
      await Promise.resolve();
    }
    expect(rewind).toHaveBeenCalledTimes(1);

    await harness.registry.runTransition(['claude'], async () => undefined);
    await harness.coordinator.bindConversation({
      conversationId: 'conversation-2',
      providerId: 'codex',
    });
    await harness.coordinator.prepare();
    harness.repository.persistExecutionSnapshot.mockClear();
    harness.repository.releaseExecutionBinding.mockClear();

    nativeRewind.resolve({
      canRewind: true,
      sessionStrategy: 'preserve-provider-session',
    });
    await expect(resultPromise).resolves.toEqual({
      canRewind: true,
      sessionStrategy: 'preserve-provider-session',
    });

    expect(harness.repository.truncateConversationInputsFrom).toHaveBeenCalledWith(
      'conversation-1',
      'user-before-transition',
    );
    expect(harness.repository.persistExecutionSnapshot).not.toHaveBeenCalled();
    expect(harness.repository.releaseExecutionBinding).not.toHaveBeenCalled();
    expect(harness.coordinator.snapshot?.providerId).toBe('codex');
  });

  it('applies supported mode changes to the current session and persists its resulting snapshot', async () => {
    const harness = createHarness();
    await harness.coordinator.bindConversation({
      conversationId: 'conversation-1',
      providerId: 'claude',
    });
    await harness.coordinator.prepare();
    const session = harness.backends.get('claude')!.sessions[0];
    session.snapshot = {
      providerId: 'claude',
      revision: 5,
      status: 'idle',
      providerSessionId: 'native-mode',
    };

    await expect(harness.coordinator.setMode('plan')).resolves.toBe(true);

    expect(session.modes).toEqual(['plan']);
    expect(harness.repository.persistExecutionSnapshot).toHaveBeenCalledWith(
      'conversation-1',
      'local-1',
      0,
      session.snapshot,
    );
  });

  it('drops the session on lifecycle invalidation and recreates it at the new generation', async () => {
    const harness = createHarness();
    await harness.coordinator.bindConversation({
      conversationId: 'conversation-1',
      providerId: 'claude',
    });
    await harness.coordinator.prepare();
    const first = harness.backends.get('claude')!.sessions[0];

    await harness.registry.runTransition(['claude'], async () => undefined);

    expect(first.disposeCalls).toBe(1);
    expect(harness.coordinator.state).toBe('stale');
    await harness.coordinator.prepare();
    expect(harness.backends.get('claude')!.sessions).toHaveLength(2);
    expect(harness.repository.registerExecutionBinding).toHaveBeenLastCalledWith(
      'conversation-1',
      'local-2',
      1,
    );
  });

  it('disposes idempotently and never acquires again', async () => {
    const harness = createHarness();
    await harness.coordinator.bindConversation({
      conversationId: 'conversation-1',
      providerId: 'claude',
    });
    await harness.coordinator.prepare();

    await Promise.all([
      harness.coordinator.dispose(),
      harness.coordinator.dispose(),
    ]);

    expect(harness.backends.get('claude')!.sessions[0].disposeCalls).toBe(1);
    await expect(harness.coordinator.prepare()).rejects.toThrow(
      'Chat execution coordinator is disposed',
    );
  });
});
