import {
  isModeConfigurableExecutionSession,
  isRewindableExecutionSession,
  isSteerableExecutionSession,
  type ProviderApprovalInteractionRequest,
  type ProviderApprovalInteractionResponse,
  type ProviderExecutionEvent,
  type ProviderExecutionRequest,
  type ProviderExecutionRun,
  type ProviderExecutionSession,
  type ProviderInteractionDismissReason,
  type ProviderInteractionPort,
  type ProviderPlanInteractionRequest,
  type ProviderPlanInteractionResponse,
  type ProviderQuestionInteractionRequest,
  type ProviderQuestionInteractionResponse,
  type ProviderSessionEvent,
  type ProviderSessionSnapshot,
  type ProviderSessionStatus,
  type RewindableExecutionSession,
  type SteerableExecutionSession,
} from '@/core/execution';

function createRequest(signal = new AbortController().signal): ProviderExecutionRequest {
  return {
    input: [
      { type: 'text', text: 'Explain the selection' },
      {
        type: 'image',
        image: {
          id: 'image-1',
          name: 'diagram.png',
          mediaType: 'image/png',
          data: 'c2FuaXRpemVk',
          size: 9,
          source: 'paste',
        },
      },
    ],
    context: {
      linkedContent: { path: 'Notes/design.md' },
      editorSelection: {
        notePath: 'Notes/design.md',
        mode: 'selection',
        selectedText: 'selected',
      },
      browserSelection: {
        source: 'browser',
        selectedText: 'browser text',
        url: 'https://example.test',
      },
      canvasSelection: {
        canvasPath: 'Boards/design.canvas',
        nodeIds: ['node-1'],
      },
      externalContextPaths: ['/external/reference.md'],
    },
    conversationHistory: [],
    configuration: {
      systemInstructions: {
        kind: 'explicit',
        instructions: 'Return a concise answer.',
      },
      model: 'provider-model',
      reasoning: 'high',
      permissionMode: 'normal',
      serviceTier: 'default',
      mode: 'plan',
      externalWorkspaceRoots: ['/external'],
    },
    toolPolicy: { kind: 'read-only' },
    signal,
  };
}

describe('Provider system instructions', () => {
  it('carries provider-default dynamic sections as execution configuration', () => {
    const request = createRequest();
    const configured: ProviderExecutionRequest = {
      ...request,
      configuration: {
        ...request.configuration,
        systemInstructions: {
          dynamicSections: ['## Collab Mode\nRuntime guidance.'],
          kind: 'provider-default',
        },
      },
    };

    expect(configured.configuration.systemInstructions).toEqual({
      dynamicSections: ['## Collab Mode\nRuntime guidance.'],
      kind: 'provider-default',
    });
  });
});

class ContractRun implements ProviderExecutionRun {
  readonly executionId: string;
  readonly turnId: string;
  readonly events: AsyncIterable<ProviderExecutionEvent>;

  private cancelRequested = false;
  private terminal = false;

  constructor(
    sessionInstanceId: string,
    index: number,
    request: ProviderExecutionRequest,
    private readonly onFinished: () => void,
  ) {
    this.executionId = `execution-${index}`;
    this.turnId = `turn-${index}`;
    this.events = this.consume(sessionInstanceId, request);
  }

  cancel(): void {
    this.cancelRequested = true;
  }

  private async *consume(
    sessionInstanceId: string,
    request: ProviderExecutionRequest,
  ): AsyncGenerator<ProviderExecutionEvent> {
    const scope = (sequence: number) => ({
      kind: 'requested' as const,
      sessionInstanceId,
      executionId: this.executionId,
      turnId: this.turnId,
      sequence,
    });
    const abort = () => this.cancel();
    request.signal.addEventListener('abort', abort, { once: true });

    try {
      yield {
        type: 'turn_started',
        scope: scope(0),
        accepted: true,
        nativeTurnId: `native-${this.turnId}`,
      };

      await Promise.resolve();
      if (this.cancelRequested || request.signal.aborted) {
        this.terminal = true;
        yield {
          type: 'cancelled',
          scope: scope(1),
          reason: 'cancelled',
        };
        return;
      }

      yield {
        type: 'text_delta',
        scope: scope(1),
        text: 'response',
      };
      yield {
        type: 'session_state_changed',
        scope: scope(2),
        snapshot: {
          providerId: 'test',
          revision: 1,
          providerSessionId: 'native-session',
          providerState: { cursor: 'opaque' },
          status: 'executing',
        },
      };
      this.terminal = true;
      yield {
        type: 'turn_completed',
        scope: scope(3),
        reason: 'completed',
        nativeAssistantId: 'assistant-1',
      };
    } finally {
      request.signal.removeEventListener('abort', abort);
      if (!this.terminal) {
        this.cancel();
      }
      this.onFinished();
    }
  }
}

class ContractSession implements ProviderExecutionSession {
  readonly providerId = 'test';
  readonly sessionInstanceId = 'session-1';

  cancelCalls = 0;
  disposeCalls = 0;
  private activeRun: ContractRun | null = null;
  private disposed = false;
  private revision = 0;
  private readonly listeners = new Set<(event: ProviderSessionEvent) => void>();

  execute(request: ProviderExecutionRequest): ProviderExecutionRun {
    if (this.disposed) {
      throw new Error('Session is disposed');
    }
    if (this.activeRun) {
      throw new Error('A requested execution is already active');
    }

    const run = new ContractRun(
      this.sessionInstanceId,
      this.revision + 1,
      request,
      () => {
        if (this.activeRun === run) {
          this.activeRun = null;
        }
      },
    );
    this.activeRun = run;
    this.revision += 1;
    return run;
  }

  cancel(): void {
    this.cancelCalls += 1;
    this.activeRun?.cancel();
  }

  getSnapshot(): ProviderSessionSnapshot {
    const status = this.getStatus();
    if (status === 'invalidated') {
      return {
        providerId: this.providerId,
        revision: this.revision,
        status,
        invalidation: {
          reason: 'provider-error',
          recoverable: true,
        },
      };
    }
    return {
      providerId: this.providerId,
      revision: this.revision,
      status,
    };
  }

  getStatus(): ProviderSessionStatus {
    if (this.disposed) return 'disposed';
    return this.activeRun ? 'executing' : 'idle';
  }

  onEvent(listener: (event: ProviderSessionEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emitSessionEvent(event: ProviderSessionEvent): void {
    if (this.disposed) return;
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // The session contract isolates consumer failures.
      }
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposeCalls += 1;
    this.cancel();
    this.disposed = true;
    this.listeners.clear();
  }
}

async function collect(
  events: AsyncIterable<ProviderExecutionEvent>,
): Promise<ProviderExecutionEvent[]> {
  const collected: ProviderExecutionEvent[] = [];
  for await (const event of events) {
    collected.push(event);
  }
  return collected;
}

describe('provider execution contracts', () => {
  it('represents streaming and one-shot output with one correlated event stream', async () => {
    const session = new ContractSession();
    const run = session.execute(createRequest());

    const events = await collect(run.events);

    expect(events.map((event) => event.type)).toEqual([
      'turn_started',
      'text_delta',
      'session_state_changed',
      'turn_completed',
    ]);
    expect(events.map((event) => event.scope.sequence)).toEqual([0, 1, 2, 3]);
    expect(
      events.filter((event) =>
        ['turn_completed', 'cancelled', 'execution_error'].includes(event.type),
      ),
    ).toHaveLength(1);
    expect(
      events.every(
        (event) =>
          event.scope.kind === 'requested' &&
          event.scope.sessionInstanceId === session.sessionInstanceId &&
          event.scope.executionId === run.executionId &&
          event.scope.turnId === run.turnId,
      ),
    ).toBe(true);
    expect(session.getStatus()).toBe('idle');
  });

  it('fails immediately when a second requested execution is active', async () => {
    const session = new ContractSession();
    const first = session.execute(createRequest());

    expect(() => session.execute(createRequest())).toThrow(
      'A requested execution is already active',
    );

    await collect(first.events);
    expect(() => session.execute(createRequest())).not.toThrow();
  });

  it('terminates cancellation through the event stream for run, request, and session cancellation', async () => {
    const runSession = new ContractSession();
    const run = runSession.execute(createRequest());
    run.cancel();
    await expect(collect(run.events)).resolves.toEqual([
      expect.objectContaining({ type: 'turn_started' }),
      expect.objectContaining({ type: 'cancelled' }),
    ]);

    const requestSession = new ContractSession();
    const requestAbort = new AbortController();
    const requestRun = requestSession.execute(createRequest(requestAbort.signal));
    requestAbort.abort();
    expect((await collect(requestRun.events)).at(-1)?.type).toBe('cancelled');

    const session = new ContractSession();
    const sessionRun = session.execute(createRequest());
    session.cancel();
    expect((await collect(sessionRun.events)).at(-1)?.type).toBe('cancelled');
  });

  it('cancels when iteration ends early and disposes idempotently', async () => {
    const session = new ContractSession();
    const run = session.execute(createRequest());

    for await (const event of run.events) {
      expect(event.type).toBe('turn_started');
      break;
    }

    expect(() => session.execute(createRequest())).not.toThrow();
    await session.dispose();
    await session.dispose();
    expect(session.disposeCalls).toBe(1);
    expect(session.getStatus()).toBe('disposed');
    expect(() => session.execute(createRequest())).toThrow('Session is disposed');
  });

  it('fences late requested and session-level output after disposal', async () => {
    const session = new ContractSession();
    const sessionListener = jest.fn();
    session.onEvent(sessionListener);
    const run = session.execute(createRequest());

    await session.dispose();
    const events = await collect(run.events);
    session.emitSessionEvent({
      type: 'session_error',
      scope: {
        kind: 'session',
        sessionInstanceId: session.sessionInstanceId,
        sequence: 0,
      },
      category: 'transport',
      message: 'late transport error',
      recoverable: true,
    });

    expect(events.at(-1)?.type).toBe('cancelled');
    expect(events.some((event) => event.type === 'text_delta')).toBe(false);
    expect(sessionListener).not.toHaveBeenCalled();
  });

  it('expresses immutable snapshot revisions and invalidation state', () => {
    const snapshots: ProviderSessionSnapshot[] = [
      {
        providerId: 'codex',
        revision: 1,
        providerSessionId: 'thread-1',
        providerState: { native: 'opaque' },
        status: 'idle',
      },
      {
        providerId: 'codex',
        revision: 2,
        providerSessionId: 'thread-1',
        providerState: { native: 'opaque' },
        status: 'invalidated',
        invalidation: {
          reason: 'provider-session-missing',
          recoverable: true,
        },
      },
    ];

    expect(snapshots[1].revision).toBeGreaterThan(snapshots[0].revision);
    expect(snapshots[1].invalidation).toEqual({
      reason: 'provider-session-missing',
      recoverable: true,
    });
  });

  it('expresses provider-state deletion as an immutable delete-before-set patch', () => {
    const providerStateDeletes = [
      'consumedSeed',
      'absentKey',
      'consumedSeed',
    ] as const;
    const snapshot: ProviderSessionSnapshot = {
      providerId: 'codex',
      revision: 3,
      providerSessionId: 'thread-2',
      providerStateDeletes,
      providerState: {
        consumedSeed: 'replacement-wins',
        activeCursor: 'cursor-2',
      },
      status: 'idle',
    };

    expect(snapshot.providerStateDeletes).toBe(providerStateDeletes);
    expect(snapshot).toMatchObject({
      providerStateDeletes: [
        'consumedSeed',
        'absentKey',
        'consumedSeed',
      ],
      providerState: {
        consumedSeed: 'replacement-wins',
        activeCursor: 'cursor-2',
      },
    });
  });

  it('keeps background and out-of-turn session events on their own monotonic scopes', () => {
    const session = new ContractSession();
    const observed: ProviderSessionEvent[] = [];
    session.onEvent((event) => observed.push(event));
    session.onEvent(() => {
      throw new Error('render listener failure');
    });

    session.emitSessionEvent({
      type: 'background_turn_started',
      scope: {
        kind: 'background',
        sessionInstanceId: session.sessionInstanceId,
        turnId: 'automatic-turn',
        sequence: 0,
      },
      nativeTurnId: 'native-auto',
    });
    session.emitSessionEvent({
      type: 'text_delta',
      scope: {
        kind: 'background',
        sessionInstanceId: session.sessionInstanceId,
        turnId: 'automatic-turn',
        sequence: 1,
      },
      text: 'automatic output',
    });
    session.emitSessionEvent({
      type: 'background_turn_completed',
      scope: {
        kind: 'background',
        sessionInstanceId: session.sessionInstanceId,
        turnId: 'automatic-turn',
        sequence: 2,
      },
      reason: 'completed',
    });
    session.emitSessionEvent({
      type: 'mode_changed',
      scope: {
        kind: 'session',
        sessionInstanceId: session.sessionInstanceId,
        sequence: 0,
      },
      mode: 'plan',
      snapshot: {
        providerId: 'test',
        revision: 1,
        status: 'idle',
      },
    });

    expect(observed.map((event) => event.scope.sequence)).toEqual([0, 1, 2, 0]);
    expect(observed.map((event) => event.scope.kind)).toEqual([
      'background',
      'background',
      'background',
      'session',
    ]);
  });

  it('preserves main/subagent tool identity, nesting, rich results, and provider payloads', () => {
    const events: ProviderExecutionEvent[] = [
      {
        type: 'tool_started',
        scope: {
          kind: 'requested',
          sessionInstanceId: 'session',
          executionId: 'execution',
          turnId: 'turn',
          sequence: 1,
        },
        toolCallId: 'agent-tool',
        toolScope: { kind: 'main' },
        name: 'Agent',
        input: { description: 'Investigate' },
        providerPayload: { rawInput: { nativeItem: 'opaque' } },
      },
      {
        type: 'tool_completed',
        scope: {
          kind: 'requested',
          sessionInstanceId: 'session',
          executionId: 'execution',
          turnId: 'turn',
          sequence: 2,
        },
        toolCallId: 'nested-tool',
        parentToolCallId: 'agent-tool',
        toolScope: { kind: 'subagent', subagentId: 'subagent-1' },
        content: 'result',
        isError: false,
        toolUseResult: {
          type: 'text',
          file: {
            filePath: 'Notes/result.md',
            content: 'result',
            numLines: 1,
            startLine: 1,
            totalLines: 1,
          },
        },
        providerPayload: { rawOutput: { native: true } },
      },
    ];

    expect(events[0]).toMatchObject({
      toolCallId: 'agent-tool',
      toolScope: { kind: 'main' },
    });
    expect(events[1]).toMatchObject({
      toolCallId: 'nested-tool',
      parentToolCallId: 'agent-tool',
      toolScope: { kind: 'subagent', subagentId: 'subagent-1' },
      providerPayload: { rawOutput: { native: true } },
    });
  });

  it('exposes absent optional operations through type guards instead of no-op methods', () => {
    const base = new ContractSession();
    const rewindable = Object.assign(new ContractSession(), {
      previewRewind: jest.fn(),
      rewind: jest.fn(),
    }) satisfies ProviderExecutionSession & RewindableExecutionSession;
    const steerable = Object.assign(new ContractSession(), {
      steer: jest.fn(),
    });
    const configurable = Object.assign(new ContractSession(), {
      setMode: jest.fn(),
    });

    expect(isRewindableExecutionSession(base)).toBe(false);
    expect(isSteerableExecutionSession(base)).toBe(false);
    expect(isModeConfigurableExecutionSession(base)).toBe(false);
    expect(isRewindableExecutionSession(rewindable)).toBe(true);
    expect(isSteerableExecutionSession(steerable)).toBe(true);
    expect(isModeConfigurableExecutionSession(configurable)).toBe(true);
  });

  it('allows steer adapters to reject when native acceptance is unknown', async () => {
    const unknownDisposition = new Error('Native steer disposition is unknown');
    const steerable = Object.assign(new ContractSession(), {
      steer: async (_request: ProviderExecutionRequest): Promise<boolean> => {
        throw unknownDisposition;
      },
    }) satisfies ProviderExecutionSession & SteerableExecutionSession;

    expect(isSteerableExecutionSession(steerable)).toBe(true);
    await expect(steerable.steer(createRequest())).rejects.toBe(
      unknownDisposition,
    );
  });
});

class RecordingInteractionPort implements ProviderInteractionPort {
  readonly dismissed: Array<{
    interactionId: string;
    reason: ProviderInteractionDismissReason;
  }> = [];

  async requestApproval(
    request: ProviderApprovalInteractionRequest,
    signal: AbortSignal,
  ): Promise<ProviderApprovalInteractionResponse> {
    if (signal.aborted) throw signal.reason;
    return { interactionId: request.interactionId, decision: 'allow' };
  }

  async askUserQuestion(
    request: ProviderQuestionInteractionRequest,
    signal: AbortSignal,
  ): Promise<ProviderQuestionInteractionResponse> {
    if (signal.aborted) throw signal.reason;
    return {
      interactionId: request.interactionId,
      answers: { language: 'TypeScript' },
    };
  }

  async requestPlanDecision(
    request: ProviderPlanInteractionRequest,
    signal: AbortSignal,
  ): Promise<ProviderPlanInteractionResponse> {
    if (signal.aborted) throw signal.reason;
    return {
      interactionId: request.interactionId,
      decision: { type: 'approve' },
    };
  }

  dismissInteraction(
    interactionId: string,
    reason: ProviderInteractionDismissReason,
  ): void {
    this.dismissed.push({ interactionId, reason });
  }
}

describe('ProviderInteractionPort', () => {
  it('echoes stable typed identity through sequential interaction responses', async () => {
    const port = new RecordingInteractionPort();
    const signal = new AbortController().signal;
    const identity = {
      sessionInstanceId: 'session-1',
      turnId: 'turn-1',
    };

    const approval = await port.requestApproval(
      {
        ...identity,
        interactionId: 'approval-1',
        kind: 'approval',
        toolName: 'Read',
        input: { path: 'Notes/design.md' },
        description: 'Read a note',
      },
      signal,
    );
    const question = await port.askUserQuestion(
      {
        ...identity,
        interactionId: 'question-1',
        kind: 'question',
        input: { questions: [] },
      },
      signal,
    );
    const plan = await port.requestPlanDecision(
      {
        ...identity,
        interactionId: 'plan-1',
        kind: 'plan-decision',
        input: { plan: 'Implement' },
      },
      signal,
    );

    expect([approval.interactionId, question.interactionId, plan.interactionId]).toEqual([
      'approval-1',
      'question-1',
      'plan-1',
    ]);
  });

  it('dismisses exactly one interaction and surfaces abort rather than stale resolution', async () => {
    const port = new RecordingInteractionPort();
    port.dismissInteraction('question-1', 'superseded');

    expect(port.dismissed).toEqual([
      { interactionId: 'question-1', reason: 'superseded' },
    ]);

    const abort = new AbortController();
    abort.abort(new Error('session disposed'));
    await expect(
      port.requestApproval(
        {
          sessionInstanceId: 'session-1',
          turnId: 'turn-1',
          interactionId: 'approval-2',
          kind: 'approval',
          toolName: 'Write',
          input: {},
          description: 'Write a file',
        },
        abort.signal,
      ),
    ).rejects.toThrow('session disposed');
  });
});
