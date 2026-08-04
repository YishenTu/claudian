import { TEST_CODEX_MODEL } from '@test/helpers/codexModels';

import type {
  ProviderExecutionEvent,
  ProviderExecutionRequest,
  ProviderInteractionPort,
  ProviderSessionConfig,
  ProviderSessionEvent,
} from '@/core/execution';
import { isSteerableExecutionSession } from '@/core/execution';
import type { ProviderHost } from '@/core/providers/ProviderHost';

const mockTransportRequest = jest.fn();
const mockTransportNotify = jest.fn();
const mockTransportOnNotification = jest.fn();
const mockTransportOnServerRequest = jest.fn();
const mockTransportDispose = jest.fn();
const mockTransportStart = jest.fn();
const mockResolveLaunchSpec = jest.fn();

jest.mock('@/providers/codex/runtime/CodexRpcTransport', () => {
  const actual = jest.requireActual('@/providers/codex/runtime/CodexRpcTransport');
  return {
    ...actual,
    CodexRpcTransport: jest.fn().mockImplementation(() => ({
      request: mockTransportRequest,
      notify: mockTransportNotify,
      onNotification: mockTransportOnNotification,
      onServerRequest: mockTransportOnServerRequest,
      dispose: mockTransportDispose,
      start: mockTransportStart,
    })),
  };
});

const mockProcessStart = jest.fn();
const mockProcessShutdown = jest.fn().mockResolvedValue(undefined);
const mockProcessIsAlive = jest.fn().mockReturnValue(true);
const mockProcessOnExit = jest.fn();
const mockProcessOffExit = jest.fn();

jest.mock('@/providers/codex/runtime/CodexAppServerProcess', () => ({
  CodexAppServerProcess: jest.fn().mockImplementation(() => ({
    start: mockProcessStart,
    shutdown: mockProcessShutdown,
    isAlive: mockProcessIsAlive,
    onExit: mockProcessOnExit,
    offExit: mockProcessOffExit,
  })),
}));

jest.mock('@/providers/codex/runtime/codexAppServerSupport', () => {
  const actual = jest.requireActual('@/providers/codex/runtime/codexAppServerSupport');
  return {
    ...actual,
    resolveCodexAppServerLaunchSpec: (...args: unknown[]) => mockResolveLaunchSpec(...args),
  };
});

import { CodexExecutionBackend } from '@/providers/codex/execution/CodexExecutionBackend';
import { CodexRpcResponseError } from '@/providers/codex/runtime/CodexRpcTransport';

type NotificationHandler = (params: unknown) => void;
type ServerRequestHandler = (
  requestId: string | number,
  params: unknown,
) => Promise<unknown>;

let notificationHandlers: Map<string, NotificationHandler>;
let serverRequestHandlers: Map<string, ServerRequestHandler>;
let exitHandler: (() => void) | null;

interface Deferred<T> {
  readonly promise: Promise<T>;
  reject(reason: unknown): void;
  resolve(value: T): void;
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, reject, resolve };
}

async function waitForCondition(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20 && !condition(); attempt += 1) {
    await Promise.resolve();
  }
  expect(condition()).toBe(true);
}

function captureHandlers(): void {
  notificationHandlers = new Map();
  serverRequestHandlers = new Map();
  exitHandler = null;
  mockTransportOnNotification.mockImplementation(
    (method: string, handler: NotificationHandler) => {
      notificationHandlers.set(method, handler);
    },
  );
  mockTransportOnServerRequest.mockImplementation(
    (method: string, handler: ServerRequestHandler) => {
      serverRequestHandlers.set(method, handler);
    },
  );
  mockProcessOnExit.mockImplementation((handler: () => void) => {
    exitHandler = handler;
  });
}

function emitNotification(method: string, params: unknown): void {
  notificationHandlers.get(method)?.(params);
}

function createThreadResult(threadId: string, turns: Array<{ id: string }> = []) {
  return {
    thread: {
      id: threadId,
      path: `/tmp/sessions/${threadId}.jsonl`,
      preview: '',
      ephemeral: false,
      status: { type: 'idle' },
      turns: turns.map(turn => ({
        ...turn,
        items: [],
        status: 'completed',
        error: null,
      })),
      cwd: '/vault',
      cliVersion: '0.146.0',
      modelProvider: 'openai',
      source: 'app-server',
      createdAt: 0,
      lastActivityAt: 0,
      agentNickname: null,
      agentRole: null,
      gitInfo: null,
      name: null,
    },
    model: TEST_CODEX_MODEL,
    modelProvider: 'openai',
    serviceTier: null,
    cwd: '/vault',
    approvalPolicy: 'never',
    approvalsReviewer: 'user',
    sandbox: { type: 'readOnly', access: { type: 'fullAccess' }, networkAccess: false },
    reasoningEffort: 'medium',
  };
}

function createTurnResult(turnId: string) {
  return {
    turn: { id: turnId, items: [], status: 'inProgress', error: null },
  };
}

function createPlugin(): ProviderHost {
  return {
    settings: {
      model: TEST_CODEX_MODEL,
      effortLevel: 'medium',
      serviceTier: 'default',
      permissionMode: 'normal',
      systemPrompt: '',
      mediaFolder: '',
      userName: '',
      providerConfigs: {
        codex: {
          discoveredModels: [{
            model: TEST_CODEX_MODEL,
            displayName: 'Test Codex',
            description: '',
            supportedReasoningEfforts: [
              { value: 'low', description: '' },
              { value: 'medium', description: '' },
              { value: 'high', description: '' },
            ],
            defaultReasoningEffort: 'medium',
            serviceTiers: [{ id: 'priority', name: 'Fast', description: '' }],
            defaultServiceTier: null,
            inputModalities: ['text', 'image'],
            isDefault: true,
          }],
        },
      },
    },
    app: {
      vault: { adapter: { basePath: '/vault' } },
    },
    storage: {} as ProviderHost['storage'],
    saveSettings: jest.fn(),
    mutateSettings: jest.fn(),
    mutateSettingsConditionally: jest.fn(),
    loadData: jest.fn(),
    saveData: jest.fn(),
    normalizeModelVariantSettings: jest.fn(),
    getActiveEnvironmentVariables: jest.fn().mockReturnValue(''),
    getEnvironmentVariablesForScope: jest.fn().mockReturnValue(''),
    applyEnvironmentVariables: jest.fn(),
    applyEnvironmentVariablesBatch: jest.fn(),
    getResolvedProviderCliPath: jest.fn().mockResolvedValue('/usr/local/bin/codex'),
    runProviderExecutionTransition: jest.fn(),
    notifyProviderChatOptionsChanged: jest.fn(),
  } as unknown as ProviderHost;
}

function createInteractionPort(): ProviderInteractionPort {
  return {
    requestApproval: jest.fn().mockImplementation(async request => ({
      interactionId: request.interactionId,
      decision: 'allow',
    })),
    askUserQuestion: jest.fn().mockImplementation(async request => ({
      interactionId: request.interactionId,
      answers: { choice: 'yes' },
    })),
    requestPlanDecision: jest.fn().mockImplementation(async request => ({
      interactionId: request.interactionId,
      decision: null,
    })),
    dismissInteraction: jest.fn(),
  };
}

function createSessionConfig(
  overrides: Partial<ProviderSessionConfig> = {},
): ProviderSessionConfig {
  return {
    lifecycle: 'persistent',
    nativePersistence: 'enabled',
    vaultWorkingDirectory: '/vault',
    interactionPort: createInteractionPort(),
    ...overrides,
  };
}

function createForkSessionConfig(
  providerState: Record<string, unknown> = {},
): ProviderSessionConfig {
  return createSessionConfig({
    resumeSeed: {
      providerState: {
        forkSourceSessionFilePath: '/tmp/source.jsonl',
        forkSourceTranscriptRootPath: '/tmp/sessions',
        forkSource: { sessionId: 'thread-source', resumeAt: 'checkpoint' },
        unknownFutureState: { keep: true },
        ...providerState,
      },
    },
  });
}

function expectPendingForkOwnership(
  session: ReturnType<CodexExecutionBackend['createSession']>,
  status: 'idle' | 'invalidated' | 'disposed' = 'idle',
): void {
  expect(session.getSnapshot()).toMatchObject({
    providerSessionId: 'thread-fork-target',
    providerState: {
      forkSource: { sessionId: 'thread-source', resumeAt: 'checkpoint' },
      pendingForkTarget: {
        sessionFilePath: '/tmp/sessions/thread-fork-target.jsonl',
        threadId: 'thread-fork-target',
      },
      threadId: 'thread-fork-target',
      unknownFutureState: { keep: true },
    },
    status,
  });
  expect(session.getSnapshot().providerStateDeletes).toBeUndefined();
}

function expectPendingForkOwnershipEvent(
  events: readonly ProviderExecutionEvent[],
): void {
  expect(events).toEqual(expect.arrayContaining([
    expect.objectContaining({
      type: 'session_state_changed',
      snapshot: expect.objectContaining({
        providerSessionId: 'thread-fork-target',
        providerState: expect.objectContaining({
          forkSource: { sessionId: 'thread-source', resumeAt: 'checkpoint' },
          pendingForkTarget: {
            sessionFilePath: '/tmp/sessions/thread-fork-target.jsonl',
            threadId: 'thread-fork-target',
          },
          threadId: 'thread-fork-target',
          unknownFutureState: { keep: true },
        }),
      }),
    }),
  ]));
}

async function flushMicrotasks(iterations = 10): Promise<void> {
  for (let index = 0; index < iterations; index += 1) {
    await Promise.resolve();
  }
}

function createRequest(
  signal: AbortSignal = new AbortController().signal,
  overrides: Partial<ProviderExecutionRequest> = {},
): ProviderExecutionRequest {
  return {
    input: [{ type: 'text', text: 'hello' }],
    configuration: {
      systemInstructions: { kind: 'explicit', instructions: 'Be concise.' },
      model: TEST_CODEX_MODEL,
      reasoning: 'high',
      serviceTier: 'priority',
      permissionMode: 'normal',
    },
    toolPolicy: { kind: 'provider-default' },
    signal,
    ...overrides,
  };
}

async function collectEvents(
  events: AsyncIterable<ProviderExecutionEvent>,
): Promise<ProviderExecutionEvent[]> {
  const result: ProviderExecutionEvent[] = [];
  for await (const event of events) {
    result.push(event);
  }
  return result;
}

function completeTurn(threadId: string, turnId: string): void {
  emitNotification('turn/completed', {
    threadId,
    turn: { id: turnId, items: [], status: 'completed', error: null },
  });
}

function configureSteerTransport(
  threadId: string,
  turnId: string,
  steer: () => unknown | Promise<unknown>,
): void {
  mockTransportRequest.mockImplementation(async (method: string) => {
    if (method === 'initialize') {
      return {
        userAgent: 'test',
        codexHome: '/tmp/.codex',
        platformFamily: 'unix',
        platformOs: 'macos',
      };
    }
    if (method === 'thread/start') return createThreadResult(threadId);
    if (method === 'turn/start') return createTurnResult(turnId);
    if (method === 'turn/steer') return steer();
    if (method === 'turn/interrupt') return {};
    throw new Error(`Unexpected method: ${method}`);
  });
}

async function createActiveSteerSession() {
  const session = new CodexExecutionBackend(createPlugin())
    .createSession(createSessionConfig());
  const run = session.execute(createRequest());
  await waitForCondition(() => mockTransportRequest.mock.calls.some(
    ([method]) => method === 'turn/start',
  ));
  if (!isSteerableExecutionSession(session)) {
    throw new Error('Codex session should be steerable');
  }
  return { run, session };
}

describe('CodexExecutionBackend', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    captureHandlers();
    mockProcessIsAlive.mockReturnValue(true);
    mockResolveLaunchSpec.mockResolvedValue({
      target: {
        method: 'host-native',
        platformFamily: 'unix',
        platformOs: 'macos',
      },
      command: '/usr/local/bin/codex',
      args: ['app-server', '--listen', 'stdio://'],
      spawnCwd: '/vault',
      targetCwd: '/vault',
      env: { HOME: '/tmp' },
      pathMapper: {
        target: {
          method: 'host-native',
          platformFamily: 'unix',
          platformOs: 'macos',
        },
        toTargetPath: (value: string) => value,
        toHostPath: (value: string) => value,
        mapTargetPathList: (values: string[]) => values,
        canRepresentHostPath: () => true,
      },
    });
  });

  it('starts a persistent thread and emits correlated lifecycle and output events', async () => {
    mockTransportRequest.mockImplementation(async (method: string) => {
      if (method === 'initialize') {
        return {
          userAgent: 'test',
          codexHome: '/tmp/.codex',
          platformFamily: 'unix',
          platformOs: 'macos',
        };
      }
      if (method === 'thread/start') return createThreadResult('thread-new');
      if (method === 'turn/start') {
        queueMicrotask(() => {
          emitNotification('item/started', {
            threadId: 'thread-new',
            turnId: 'turn-new',
            item: {
              type: 'userMessage',
              id: 'user-item',
              content: [{ type: 'text', text: 'hello' }],
            },
          });
          emitNotification('item/agentMessage/delta', {
            threadId: 'thread-new',
            turnId: 'turn-new',
            itemId: 'assistant-item',
            delta: 'Hello',
          });
          completeTurn('thread-new', 'turn-new');
        });
        return createTurnResult('turn-new');
      }
      throw new Error(`Unexpected method: ${method}`);
    });

    const session = new CodexExecutionBackend(createPlugin())
      .createSession(createSessionConfig());
    const run = session.execute(createRequest());
    const events = await collectEvents(run.events);

    expect(mockTransportNotify).toHaveBeenCalledWith('initialized');
    expect(mockTransportRequest).toHaveBeenCalledWith(
      'thread/start',
      expect.objectContaining({
        cwd: '/vault',
        experimentalRawEvents: true,
        persistExtendedHistory: true,
        dynamicTools: [
          expect.objectContaining({
            namespace: 'codex_app',
            name: 'load_workspace_dependencies',
          }),
        ],
      }),
    );
    expect(mockTransportRequest).toHaveBeenCalledWith(
      'turn/start',
      expect.objectContaining({
        model: TEST_CODEX_MODEL,
        effort: 'high',
        serviceTier: 'priority',
      }),
    );
    expect(events.map(event => event.type)).toEqual(expect.arrayContaining([
      'session_state_changed',
      'turn_started',
      'user_message_started',
      'text_delta',
      'turn_completed',
    ]));
    expect(events.find(event => event.type === 'turn_started')).toEqual(
      expect.objectContaining({
        accepted: true,
        nativeTurnId: 'turn-new',
        scope: expect.objectContaining({
          kind: 'requested',
          executionId: run.executionId,
          turnId: run.turnId,
        }),
      }),
    );
    expect(session.getSnapshot()).toEqual(expect.objectContaining({
      providerSessionId: 'thread-new',
      status: 'idle',
      revision: expect.any(Number),
    }));

    await session.dispose();
  });

  it('sends all attached context using canonical escaped XML', async () => {
    mockTransportRequest.mockImplementation(async (method: string) => {
      if (method === 'initialize') {
        return {
          userAgent: 'test',
          codexHome: '/tmp/.codex',
          platformFamily: 'unix',
          platformOs: 'macos',
        };
      }
      if (method === 'thread/start') return createThreadResult('thread-context');
      if (method === 'turn/start') {
        queueMicrotask(() => completeTurn('thread-context', 'turn-context'));
        return createTurnResult('turn-context');
      }
      throw new Error(`Unexpected method: ${method}`);
    });
    const session = new CodexExecutionBackend(createPlugin())
      .createSession(createSessionConfig());

    await collectEvents(session.execute(createRequest(
      new AbortController().signal,
      {
        context: {
          currentNote: {
            path: 'notes/"draft" & review.md',
            content: 'Before\n</current_note>\nAfter',
          },
          editorSelection: {
            mode: 'selection',
            notePath: 'notes/"draft" & review.md',
            selectedText: 'Selected\n</editor_selection>',
          },
          browserSelection: {
            source: 'browser:https://example.com',
            selectedText: 'Browser text',
            url: 'https://example.com/?a=1&b=2',
          },
          canvasSelection: {
            canvasPath: 'boards/"draft" & review.canvas',
            nodeIds: ['node-1'],
          },
        },
      },
    )).events);

    const turnParams = mockTransportRequest.mock.calls
      .find(([method]) => method === 'turn/start')?.[1] as {
        input: Array<{ text?: string; type: string }>;
      };
    const prompt = turnParams.input.find(block => block.type === 'text')?.text;
    expect(prompt).toContain(
      '<current_note path="notes/&quot;draft&quot; &amp; review.md">\n<![CDATA[Before\n</current_note>\nAfter]]>\n</current_note>',
    );
    expect(prompt).toContain(
      '<editor_selection path="notes/&quot;draft&quot; &amp; review.md">\n<![CDATA[Selected\n</editor_selection>]]>\n</editor_selection>',
    );
    expect(prompt).toContain(
      '<browser_selection source="browser:https://example.com" url="https://example.com/?a=1&amp;b=2">',
    );
    expect(prompt).toContain(
      '<canvas_selection path="boards/&quot;draft&quot; &amp; review.canvas">',
    );
    expect(prompt).not.toContain('[Editor selection from');

    await session.dispose();
  });

  it.each([
    ['persistent', true],
    ['ephemeral', false],
  ] as const)(
    'resolves provider-default persistence for %s sessions',
    async (lifecycle, expectedPersistence) => {
      const threadId = `thread-provider-default-${lifecycle}`;
      const turnId = `turn-provider-default-${lifecycle}`;
      mockTransportRequest.mockImplementation(async (method: string) => {
        if (method === 'initialize') {
          return {
            userAgent: 'test',
            codexHome: '/tmp/.codex',
            platformFamily: 'unix',
            platformOs: 'macos',
          };
        }
        if (method === 'thread/start') return createThreadResult(threadId);
        if (method === 'turn/start') {
          queueMicrotask(() => completeTurn(threadId, turnId));
          return createTurnResult(turnId);
        }
        throw new Error(`Unexpected method: ${method}`);
      });

      const session = new CodexExecutionBackend(createPlugin()).createSession(
        createSessionConfig({
          lifecycle,
          nativePersistence: 'provider-default',
        }),
      );

      await collectEvents(session.execute(createRequest()).events);

      expect(mockTransportRequest).toHaveBeenCalledWith(
        'thread/start',
        expect.objectContaining({
          persistExtendedHistory: expectedPersistence,
        }),
      );

      await session.dispose();
    },
  );

  it('resumes the fixed native seed and supports a continued turn on the same process', async () => {
    let turnIndex = 0;
    mockTransportRequest.mockImplementation(async (method: string) => {
      if (method === 'initialize') {
        return {
          userAgent: 'test',
          codexHome: '/tmp/.codex',
          platformFamily: 'unix',
          platformOs: 'macos',
        };
      }
      if (method === 'thread/resume') return createThreadResult('thread-existing');
      if (method === 'turn/start') {
        turnIndex += 1;
        const turnId = `turn-${turnIndex}`;
        queueMicrotask(() => completeTurn('thread-existing', turnId));
        return createTurnResult(turnId);
      }
      throw new Error(`Unexpected method: ${method}`);
    });

    const session = new CodexExecutionBackend(createPlugin()).createSession(
      createSessionConfig({
        resumeSeed: {
          providerSessionId: 'thread-existing',
          providerState: {
            threadId: 'thread-existing',
            sessionFilePath: '/tmp/thread-existing.jsonl',
          },
        },
      }),
    );

    await collectEvents(session.execute(createRequest()).events);
    await collectEvents(session.execute(createRequest()).events);

    expect(
      mockTransportRequest.mock.calls.filter(call => call[0] === 'thread/resume'),
    ).toHaveLength(1);
    expect(
      mockTransportRequest.mock.calls.filter(call => call[0] === 'turn/start'),
    ).toHaveLength(2);

    await session.dispose();
  });

  it('replays canonical history only when starting a thread without native context', async () => {
    let turnIndex = 0;
    mockTransportRequest.mockImplementation(async (method: string) => {
      if (method === 'initialize') {
        return {
          userAgent: 'test',
          codexHome: '/tmp/.codex',
          platformFamily: 'unix',
          platformOs: 'macos',
        };
      }
      if (method === 'thread/start') return createThreadResult('thread-history');
      if (method === 'turn/start') {
        turnIndex += 1;
        const turnId = `turn-history-${turnIndex}`;
        queueMicrotask(() => completeTurn('thread-history', turnId));
        return createTurnResult(turnId);
      }
      throw new Error(`Unexpected method: ${method}`);
    });
    const session = new CodexExecutionBackend(createPlugin())
      .createSession(createSessionConfig());
    const conversationHistory = [
      { id: 'history-user', role: 'user' as const, content: 'prior question', timestamp: 1 },
      { id: 'history-assistant', role: 'assistant' as const, content: 'prior answer', timestamp: 2 },
    ];

    const firstEvents = await collectEvents(session.execute(createRequest(
      new AbortController().signal,
      { conversationHistory },
    )).events);
    const initialOwnershipEvent = firstEvents.find(event =>
      event.type === 'session_state_changed'
      && event.snapshot.providerSessionId === 'thread-history'
    );
    expect(initialOwnershipEvent).toMatchObject({
      snapshot: { status: 'executing' },
      type: 'session_state_changed',
    });
    await collectEvents(session.execute(createRequest(
      new AbortController().signal,
      {
        conversationHistory,
        input: [{ type: 'text', text: 'Follow up' }],
      },
    )).events);

    const turnRequests = mockTransportRequest.mock.calls
      .filter(([method]) => method === 'turn/start')
      .map(([, params]) => JSON.stringify(params.input));
    expect(turnRequests[0]).toContain('prior question');
    expect(turnRequests[0]).toContain('prior answer');
    expect(turnRequests[1]).not.toContain('prior question');
    expect(turnRequests[1]).toContain('Follow up');

    await session.dispose();
  });

  it('retains cold-start history replay until the first turn is handed off', async () => {
    let turnAttempt = 0;
    mockTransportRequest.mockImplementation(async (method: string) => {
      if (method === 'initialize') {
        return {
          userAgent: 'test',
          codexHome: '/tmp/.codex',
          platformFamily: 'unix',
          platformOs: 'macos',
        };
      }
      if (method === 'thread/start' || method === 'thread/resume') {
        return createThreadResult('thread-retry');
      }
      if (method === 'turn/start') {
        turnAttempt += 1;
        if (turnAttempt === 1) throw new Error('turn rejected before handoff');
        queueMicrotask(() => completeTurn('thread-retry', 'turn-retry'));
        return createTurnResult('turn-retry');
      }
      throw new Error(`Unexpected method: ${method}`);
    });
    const session = new CodexExecutionBackend(createPlugin())
      .createSession(createSessionConfig());
    const conversationHistory = [
      { id: 'history-user', role: 'user' as const, content: 'retry prior question', timestamp: 1 },
      { id: 'history-assistant', role: 'assistant' as const, content: 'retry prior answer', timestamp: 2 },
    ];

    await collectEvents(session.execute(createRequest(
      new AbortController().signal,
      { conversationHistory },
    )).events);
    const preHandoffSnapshot = session.getSnapshot();
    expect(preHandoffSnapshot.providerState).toEqual(expect.objectContaining({
      nativeConversationContextEstablished: false,
      threadId: 'thread-retry',
    }));
    await session.dispose();

    const replacement = new CodexExecutionBackend(createPlugin()).createSession(
      createSessionConfig({
        resumeSeed: {
          providerSessionId: preHandoffSnapshot.providerSessionId,
          providerState: { ...preHandoffSnapshot.providerState },
        },
      }),
    );
    await collectEvents(replacement.execute(createRequest(
      new AbortController().signal,
      { conversationHistory },
    )).events);

    const turnRequests = mockTransportRequest.mock.calls
      .filter(([method]) => method === 'turn/start')
      .map(([, params]) => JSON.stringify(params.input));
    expect(turnRequests).toHaveLength(2);
    expect(turnRequests[0]).toContain('retry prior question');
    expect(turnRequests[1]).toContain('retry prior question');

    await replacement.dispose();
  });

  it('establishes native context when notification ordering proves early handoff', async () => {
    let turnAttempt = 0;
    mockTransportRequest.mockImplementation(async (method: string) => {
      if (method === 'initialize') {
        return {
          userAgent: 'test',
          codexHome: '/tmp/.codex',
          platformFamily: 'unix',
          platformOs: 'macos',
        };
      }
      if (method === 'thread/start') return createThreadResult('thread-early-handoff');
      if (method === 'turn/start') {
        turnAttempt += 1;
        if (turnAttempt === 1) {
          emitNotification('turn/started', {
            threadId: 'thread-early-handoff',
            turn: createTurnResult('turn-early-handoff-1').turn,
          });
          throw new Error('turn/start acknowledgement lost');
        }
        queueMicrotask(() => completeTurn(
          'thread-early-handoff',
          'turn-early-handoff-2',
        ));
        return createTurnResult('turn-early-handoff-2');
      }
      throw new Error(`Unexpected method: ${method}`);
    });
    const session = new CodexExecutionBackend(createPlugin())
      .createSession(createSessionConfig());
    const conversationHistory = [
      { id: 'history-user', role: 'user' as const, content: 'early prior question', timestamp: 1 },
      { id: 'history-assistant', role: 'assistant' as const, content: 'early prior answer', timestamp: 2 },
    ];

    const firstEvents = await collectEvents(session.execute(createRequest(
      new AbortController().signal,
      { conversationHistory },
    )).events);
    expect(firstEvents).toContainEqual(expect.objectContaining({
      accepted: true,
      type: 'turn_started',
    }));
    expect(session.getSnapshot().providerState).toEqual(expect.objectContaining({
      nativeConversationContextEstablished: true,
    }));
    await collectEvents(session.execute(createRequest(
      new AbortController().signal,
      { conversationHistory },
    )).events);

    const turnRequests = mockTransportRequest.mock.calls
      .filter(([method]) => method === 'turn/start')
      .map(([, params]) => JSON.stringify(params.input));
    expect(turnRequests[0]).toContain('early prior question');
    expect(turnRequests[1]).not.toContain('early prior question');

    await session.dispose();
  });

  it('persists native context when cancellation races a turn-start acknowledgement', async () => {
    const controller = new AbortController();
    let turnAttempt = 0;
    mockTransportRequest.mockImplementation(async (method: string) => {
      if (method === 'initialize') {
        return {
          userAgent: 'test',
          codexHome: '/tmp/.codex',
          platformFamily: 'unix',
          platformOs: 'macos',
        };
      }
      if (method === 'thread/start') {
        return createThreadResult('thread-cancelled-ack');
      }
      if (method === 'thread/resume') {
        return createThreadResult('thread-cancelled-ack');
      }
      if (method === 'turn/start') {
        turnAttempt += 1;
        if (turnAttempt === 1) {
          controller.abort();
          return createTurnResult('turn-cancelled-ack');
        }
        queueMicrotask(() => completeTurn(
          'thread-cancelled-ack',
          'turn-after-cancelled-ack',
        ));
        return createTurnResult('turn-after-cancelled-ack');
      }
      throw new Error(`Unexpected method: ${method}`);
    });
    const session = new CodexExecutionBackend(createPlugin())
      .createSession(createSessionConfig());
    const conversationHistory = [
      { id: 'history-user', role: 'user' as const, content: 'cancel prior question', timestamp: 1 },
      { id: 'history-assistant', role: 'assistant' as const, content: 'cancel prior answer', timestamp: 2 },
    ];

    const cancelledEvents = await collectEvents(session.execute(createRequest(
      controller.signal,
      { conversationHistory },
    )).events);
    expect(cancelledEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({
        snapshot: expect.objectContaining({
          providerState: expect.objectContaining({
            nativeConversationContextEstablished: true,
          }),
        }),
        type: 'session_state_changed',
      }),
    ]));
    const cancelledSnapshot = session.getSnapshot();
    expect(cancelledSnapshot.providerState).toEqual(expect.objectContaining({
      nativeConversationContextEstablished: true,
    }));
    await session.dispose();

    const replacement = new CodexExecutionBackend(createPlugin()).createSession(
      createSessionConfig({
        resumeSeed: {
          providerSessionId: cancelledSnapshot.providerSessionId,
          providerState: { ...cancelledSnapshot.providerState },
        },
      }),
    );
    await collectEvents(replacement.execute(createRequest(
      new AbortController().signal,
      { conversationHistory },
    )).events);

    const turnRequests = mockTransportRequest.mock.calls
      .filter(([method]) => method === 'turn/start')
      .map(([, params]) => JSON.stringify(params.input));
    expect(turnRequests).toHaveLength(2);
    expect(turnRequests[0]).toContain('cancel prior question');
    expect(turnRequests[1]).not.toContain('cancel prior question');

    await replacement.dispose();
  });

  it('publishes a late turn-start acknowledgement without resurrecting cancelled status', async () => {
    const turnStart = createDeferred<ReturnType<typeof createTurnResult>>();
    mockTransportRequest.mockImplementation(async (method: string) => {
      if (method === 'initialize') {
        return {
          userAgent: 'test',
          codexHome: '/tmp/.codex',
          platformFamily: 'unix',
          platformOs: 'macos',
        };
      }
      if (method === 'thread/start') {
        return createThreadResult('thread-late-turn-ack');
      }
      if (method === 'turn/start') return turnStart.promise;
      throw new Error(`Unexpected method: ${method}`);
    });
    const session = new CodexExecutionBackend(createPlugin())
      .createSession(createSessionConfig());
    const sessionEvents: ProviderSessionEvent[] = [];
    const unsubscribe = session.onEvent(event => sessionEvents.push(event));
    const run = session.execute(createRequest());
    const runEvents = collectEvents(run.events);
    await waitForCondition(() => mockTransportRequest.mock.calls.some(
      ([method]) => method === 'turn/start',
    ));

    run.cancel();
    expect((await runEvents).at(-1)).toMatchObject({ type: 'cancelled' });
    expect(session.getSnapshot().status).toBe('idle');

    turnStart.resolve(createTurnResult('turn-late-ack'));
    await flushMicrotasks();

    expect(session.getSnapshot()).toMatchObject({
      providerState: {
        nativeConversationContextEstablished: true,
      },
      status: 'idle',
    });
    expect(sessionEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({
        scope: expect.objectContaining({ kind: 'session' }),
        snapshot: expect.objectContaining({
          providerState: expect.objectContaining({
            nativeConversationContextEstablished: true,
          }),
          status: 'idle',
        }),
        type: 'session_state_changed',
      }),
    ]));

    unsubscribe();
    await session.dispose();
  });

  it('persists a new thread identity when cancellation races its acknowledgement', async () => {
    const controller = new AbortController();
    mockTransportRequest.mockImplementation(async (method: string) => {
      if (method === 'initialize') {
        return {
          userAgent: 'test',
          codexHome: '/tmp/.codex',
          platformFamily: 'unix',
          platformOs: 'macos',
        };
      }
      if (method === 'thread/start') {
        controller.abort();
        return createThreadResult('thread-cancelled-start');
      }
      if (method === 'thread/resume') {
        return createThreadResult('thread-cancelled-start');
      }
      if (method === 'turn/start') {
        queueMicrotask(() => completeTurn(
          'thread-cancelled-start',
          'turn-after-cancelled-start',
        ));
        return createTurnResult('turn-after-cancelled-start');
      }
      throw new Error(`Unexpected method: ${method}`);
    });
    const session = new CodexExecutionBackend(createPlugin())
      .createSession(createSessionConfig());

    const cancelledEvents = await collectEvents(session.execute(createRequest(
      controller.signal,
    )).events);
    expect(cancelledEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({
        snapshot: expect.objectContaining({
          providerSessionId: 'thread-cancelled-start',
          providerState: expect.objectContaining({
            nativeConversationContextEstablished: false,
            threadId: 'thread-cancelled-start',
          }),
        }),
        type: 'session_state_changed',
      }),
    ]));
    const cancelledSnapshot = session.getSnapshot();
    expect(cancelledSnapshot.providerSessionId).toBe('thread-cancelled-start');
    await session.dispose();

    const replacement = new CodexExecutionBackend(createPlugin()).createSession(
      createSessionConfig({
        resumeSeed: {
          providerSessionId: cancelledSnapshot.providerSessionId,
          providerState: { ...cancelledSnapshot.providerState },
        },
      }),
    );
    await collectEvents(replacement.execute(createRequest()).events);

    expect(mockTransportRequest.mock.calls.filter(
      ([method]) => method === 'thread/start',
    )).toHaveLength(1);
    expect(mockTransportRequest.mock.calls.filter(
      ([method]) => method === 'thread/resume',
    )).toHaveLength(1);

    await replacement.dispose();
  });

  it('publishes a late thread-start acknowledgement without resurrecting cancelled status', async () => {
    const threadStart = createDeferred<ReturnType<typeof createThreadResult>>();
    mockTransportRequest.mockImplementation(async (method: string) => {
      if (method === 'initialize') {
        return {
          userAgent: 'test',
          codexHome: '/tmp/.codex',
          platformFamily: 'unix',
          platformOs: 'macos',
        };
      }
      if (method === 'thread/start') return threadStart.promise;
      throw new Error(`Unexpected method: ${method}`);
    });
    const session = new CodexExecutionBackend(createPlugin())
      .createSession(createSessionConfig());
    const sessionEvents: ProviderSessionEvent[] = [];
    const unsubscribe = session.onEvent(event => sessionEvents.push(event));
    const run = session.execute(createRequest());
    const runEvents = collectEvents(run.events);
    await waitForCondition(() => mockTransportRequest.mock.calls.some(
      ([method]) => method === 'thread/start',
    ));

    run.cancel();
    expect((await runEvents).at(-1)).toMatchObject({ type: 'cancelled' });
    expect(session.getSnapshot().status).toBe('idle');

    threadStart.resolve(createThreadResult('thread-late-start-ack'));
    await flushMicrotasks();

    expect(session.getSnapshot()).toMatchObject({
      providerSessionId: 'thread-late-start-ack',
      providerState: {
        nativeConversationContextEstablished: false,
        threadId: 'thread-late-start-ack',
      },
      status: 'idle',
    });
    expect(sessionEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({
        scope: expect.objectContaining({ kind: 'session' }),
        snapshot: expect.objectContaining({
          providerSessionId: 'thread-late-start-ack',
          status: 'idle',
        }),
        type: 'session_state_changed',
      }),
    ]));

    unsubscribe();
    await session.dispose();
  });

  it('retains an ephemeral thread for clarification continuation', async () => {
    let turnIndex = 0;
    mockTransportRequest.mockImplementation(async (method: string) => {
      if (method === 'initialize') {
        return {
          userAgent: 'test',
          codexHome: '/tmp/.codex',
          platformFamily: 'unix',
          platformOs: 'macos',
        };
      }
      if (method === 'thread/start') return createThreadResult('thread-continuation');
      if (method === 'turn/start') {
        turnIndex += 1;
        const turnId = `turn-continuation-${turnIndex}`;
        queueMicrotask(() => completeTurn('thread-continuation', turnId));
        return createTurnResult(turnId);
      }
      throw new Error(`Unexpected method: ${method}`);
    });
    const session = new CodexExecutionBackend(createPlugin()).createSession(
      createSessionConfig({
        lifecycle: 'ephemeral',
        nativePersistence: 'disabled-if-supported',
      }),
    );

    await collectEvents(session.execute(createRequest(
      new AbortController().signal,
      { toolPolicy: { kind: 'passive' } },
    )).events);
    await collectEvents(session.execute(createRequest(
      new AbortController().signal,
      {
        input: [{ type: 'text', text: 'clarification' }],
        toolPolicy: { kind: 'passive' },
      },
    )).events);

    expect(
      mockTransportRequest.mock.calls.filter(call => call[0] === 'thread/start'),
    ).toHaveLength(1);
    expect(
      mockTransportRequest.mock.calls.filter(call => call[0] === 'turn/start'),
    ).toHaveLength(2);

    await session.dispose();
  });

  it('forks, resumes, and rolls back to the requested checkpoint before executing', async () => {
    let turnAttempt = 0;
    mockTransportRequest.mockImplementation(async (method: string) => {
      if (method === 'initialize') {
        return {
          userAgent: 'test',
          codexHome: '/tmp/.codex',
          platformFamily: 'unix',
          platformOs: 'macos',
        };
      }
      if (method === 'thread/fork') {
        return createThreadResult('thread-fork', [
          { id: 'checkpoint' },
          { id: 'later-turn' },
        ]);
      }
      if (method === 'thread/resume') {
        return createThreadResult('thread-fork', [
          { id: 'checkpoint' },
          { id: 'later-turn' },
        ]);
      }
      if (method === 'thread/rollback') return createThreadResult('thread-fork');
      if (method === 'turn/start') {
        turnAttempt += 1;
        if (turnAttempt === 2) {
          throw new Error('transport closed after fork');
        }
        const turnId = `turn-fork-${turnAttempt}`;
        queueMicrotask(() => completeTurn('thread-fork', turnId));
        return createTurnResult(turnId);
      }
      throw new Error(`Unexpected method: ${method}`);
    });

    const session = new CodexExecutionBackend(createPlugin()).createSession(
      createSessionConfig({
        resumeSeed: {
          providerState: {
            forkSourceSessionFilePath: '/tmp/source.jsonl',
            forkSourceTranscriptRootPath: '/tmp/sessions',
            forkSource: { sessionId: 'thread-source', resumeAt: 'checkpoint' },
            unknownFutureState: { keep: true },
          },
        },
      }),
    );

    const forkEvents = await collectEvents(session.execute(createRequest()).events);

    expect(mockTransportRequest.mock.calls.map(call => call[0])).toEqual([
      'initialize',
      'thread/fork',
      'thread/resume',
      'thread/rollback',
      'turn/start',
    ]);
    expect(mockTransportRequest).toHaveBeenCalledWith(
      'thread/rollback',
      { threadId: 'thread-fork', numTurns: 1 },
    );

    const forkedSnapshot = session.getSnapshot();
    expect(forkedSnapshot.providerState).toEqual(expect.objectContaining({
      threadId: 'thread-fork',
      unknownFutureState: { keep: true },
    }));
    expect(forkedSnapshot.providerState).not.toHaveProperty('forkSource');
    expect(forkedSnapshot.providerState).not.toHaveProperty('forkSourceSessionFilePath');
    expect(forkedSnapshot.providerState).not.toHaveProperty('forkSourceTranscriptRootPath');
    expect(forkedSnapshot.providerStateDeletes).toEqual([
      'forkSource',
      'forkSourceSessionFilePath',
      'forkSourceTranscriptRootPath',
      'pendingForkTarget',
    ]);
    expect(forkEvents.at(-2)).toMatchObject({
      snapshot: {
        providerStateDeletes: [
          'forkSource',
          'forkSourceSessionFilePath',
          'forkSourceTranscriptRootPath',
          'pendingForkTarget',
        ],
        status: 'idle',
      },
      type: 'session_state_changed',
    });

    const invalidatedEvents = await collectEvents(session.execute(createRequest()).events);
    expect(invalidatedEvents.at(-2)).toMatchObject({
      snapshot: {
        providerStateDeletes: [
          'forkSource',
          'forkSourceSessionFilePath',
          'forkSourceTranscriptRootPath',
          'pendingForkTarget',
        ],
        status: 'invalidated',
      },
      type: 'session_state_changed',
    });

    await collectEvents(session.execute(createRequest()).events);
    expect(mockTransportRequest.mock.calls.filter(call => call[0] === 'thread/fork'))
      .toHaveLength(1);
    expect(session.getSnapshot()).toMatchObject({
      providerState: {
        threadId: 'thread-fork',
        unknownFutureState: { keep: true },
      },
      providerStateDeletes: [
        'forkSource',
        'forkSourceSessionFilePath',
        'forkSourceTranscriptRootPath',
        'pendingForkTarget',
      ],
      status: 'idle',
    });

    await session.dispose();
  });

  it.each([
    ['checkpoint validation', 'checkpoint'] as const,
    ['thread resume', 'resume'] as const,
    ['thread rollback', 'rollback'] as const,
  ])(
    'retains one fork target across %s failure and retries its materialization',
    async (_description, failureBoundary) => {
      let forkCount = 0;
      let resumeCount = 0;
      let rollbackCount = 0;
      mockTransportRequest.mockImplementation(async (method: string) => {
        if (method === 'initialize') {
          return {
            userAgent: 'test',
            codexHome: '/tmp/.codex',
            platformFamily: 'unix',
            platformOs: 'macos',
          };
        }
        if (method === 'thread/fork') {
          forkCount += 1;
          if (forkCount > 1) throw new Error('second fork must not be issued');
          return createThreadResult(
            'thread-fork-target',
            failureBoundary === 'checkpoint'
              ? [{ id: 'different-checkpoint' }]
              : [{ id: 'checkpoint' }, { id: 'later-turn' }],
          );
        }
        if (method === 'thread/resume') {
          resumeCount += 1;
          if (failureBoundary === 'resume' && resumeCount === 1) {
            throw new Error('resume rejected');
          }
          return createThreadResult(
            'thread-fork-target',
            failureBoundary === 'checkpoint' && resumeCount === 1
              ? [{ id: 'different-checkpoint' }]
              : failureBoundary === 'rollback' && resumeCount > 1
              ? [{ id: 'checkpoint' }]
              : [{ id: 'checkpoint' }, { id: 'later-turn' }],
          );
        }
        if (method === 'thread/rollback') {
          rollbackCount += 1;
          if (failureBoundary === 'rollback' && rollbackCount === 1) {
            throw new Error('rollback response lost after apply');
          }
          return createThreadResult('thread-fork-target', [{ id: 'checkpoint' }]);
        }
        if (method === 'turn/start') {
          queueMicrotask(() => completeTurn('thread-fork-target', 'turn-after-retry'));
          return createTurnResult('turn-after-retry');
        }
        throw new Error(`Unexpected method: ${method}`);
      });

      let session = new CodexExecutionBackend(createPlugin()).createSession(
        createForkSessionConfig(),
      );
      const failedEvents = await collectEvents(session.execute(createRequest()).events);

      expect(failedEvents.at(-1)).toMatchObject({
        type: 'execution_error',
        message: expect.stringMatching(
          failureBoundary === 'checkpoint'
            ? /checkpoint not found/i
            : failureBoundary === 'resume'
              ? /resume rejected/i
          : /rollback response lost/i,
        ),
      });
      expectPendingForkOwnershipEvent(failedEvents);
      expectPendingForkOwnership(session);

      if (failureBoundary === 'checkpoint') {
        const pendingSnapshot = session.getSnapshot();
        await session.dispose();
        session = new CodexExecutionBackend(createPlugin()).createSession(
          createSessionConfig({
            resumeSeed: {
              providerSessionId: pendingSnapshot.providerSessionId,
              providerState: { ...pendingSnapshot.providerState },
            },
          }),
        );
      }

      const retryEvents = await collectEvents(session.execute(createRequest()).events);

      expect(retryEvents.at(-1)).toMatchObject({ type: 'turn_completed' });
      expect(forkCount).toBe(1);
      expect(resumeCount).toBeGreaterThanOrEqual(1);
      expect(rollbackCount).toBe(1);
      expect(session.getSnapshot()).toMatchObject({
        providerSessionId: 'thread-fork-target',
        providerState: {
          threadId: 'thread-fork-target',
          unknownFutureState: { keep: true },
        },
        providerStateDeletes: expect.arrayContaining([
          'forkSource',
          'forkSourceSessionFilePath',
          'forkSourceTranscriptRootPath',
          'pendingForkTarget',
        ]),
        status: 'idle',
      });
      expect(session.getSnapshot().providerState).not.toHaveProperty('forkSource');
      expect(session.getSnapshot().providerState).not.toHaveProperty('pendingForkTarget');

      await session.dispose();
    },
  );

  it('joins fork setup through cancellation and retries the adopted child immediately', async () => {
    const firstResume = createDeferred<ReturnType<typeof createThreadResult>>();
    let resumeCount = 0;
    let forkCount = 0;
    mockTransportRequest.mockImplementation(async (method: string) => {
      if (method === 'initialize') {
        return {
          userAgent: 'test',
          codexHome: '/tmp/.codex',
          platformFamily: 'unix',
          platformOs: 'macos',
        };
      }
      if (method === 'thread/fork') {
        forkCount += 1;
        return createThreadResult('thread-fork-target', [
          { id: 'checkpoint' },
          { id: 'later-turn' },
        ]);
      }
      if (method === 'thread/resume') {
        resumeCount += 1;
        return resumeCount === 1
          ? firstResume.promise
          : createThreadResult('thread-fork-target', [
            { id: 'checkpoint' },
            { id: 'later-turn' },
          ]);
      }
      if (method === 'thread/rollback') {
        return createThreadResult('thread-fork-target', [{ id: 'checkpoint' }]);
      }
      if (method === 'turn/start') {
        queueMicrotask(() => completeTurn('thread-fork-target', 'turn-after-cancel'));
        return createTurnResult('turn-after-cancel');
      }
      throw new Error(`Unexpected method: ${method}`);
    });
    const session = new CodexExecutionBackend(createPlugin()).createSession(
      createForkSessionConfig(),
    );
    const run = session.execute(createRequest());
    const eventsPromise = collectEvents(run.events);
    await waitForCondition(() => resumeCount === 1);

    run.cancel();
    let cancellationSettled = false;
    void eventsPromise.then(() => { cancellationSettled = true; });
    await flushMicrotasks();

    expect(cancellationSettled).toBe(false);
    expect(mockTransportDispose).toHaveBeenCalledTimes(1);
    expect(mockProcessShutdown).toHaveBeenCalledTimes(1);
    expect(() => session.execute(createRequest())).toThrow(/active/i);
    firstResume.resolve(createThreadResult('thread-fork-target', [
      { id: 'checkpoint' },
      { id: 'later-turn' },
    ]));
    const cancelledEvents = await eventsPromise;
    expect(cancelledEvents.at(-1)).toMatchObject({ type: 'cancelled' });
    expectPendingForkOwnershipEvent(cancelledEvents);
    expectPendingForkOwnership(session);

    const retryEvents = await collectEvents(session.execute(createRequest()).events);

    expect(retryEvents.at(-1)).toMatchObject({ type: 'turn_completed' });
    expect(forkCount).toBe(1);
    expect(resumeCount).toBe(2);
    await session.dispose();
  });

  it('joins fork setup through disposal and publishes the adopted child for recreation', async () => {
    const firstResume = createDeferred<ReturnType<typeof createThreadResult>>();
    let resumeCount = 0;
    let forkCount = 0;
    mockTransportRequest.mockImplementation(async (method: string) => {
      if (method === 'initialize') {
        return {
          userAgent: 'test',
          codexHome: '/tmp/.codex',
          platformFamily: 'unix',
          platformOs: 'macos',
        };
      }
      if (method === 'thread/fork') {
        forkCount += 1;
        return createThreadResult('thread-fork-target', [
          { id: 'checkpoint' },
          { id: 'later-turn' },
        ]);
      }
      if (method === 'thread/resume') {
        resumeCount += 1;
        return resumeCount === 1
          ? firstResume.promise
          : createThreadResult('thread-fork-target', [
            { id: 'checkpoint' },
            { id: 'later-turn' },
          ]);
      }
      if (method === 'thread/rollback') {
        return createThreadResult('thread-fork-target', [{ id: 'checkpoint' }]);
      }
      if (method === 'turn/start') {
        queueMicrotask(() => completeTurn('thread-fork-target', 'turn-after-dispose'));
        return createTurnResult('turn-after-dispose');
      }
      throw new Error(`Unexpected method: ${method}`);
    });
    const session = new CodexExecutionBackend(createPlugin()).createSession(
      createForkSessionConfig(),
    );
    const run = session.execute(createRequest());
    const eventsPromise = collectEvents(run.events);
    await waitForCondition(() => resumeCount === 1);

    const disposing = session.dispose();
    let disposalSettled = false;
    void disposing.then(() => { disposalSettled = true; });
    await flushMicrotasks();

    expect(disposalSettled).toBe(false);
    expect(mockTransportDispose).toHaveBeenCalledTimes(1);
    expect(mockProcessShutdown).toHaveBeenCalledTimes(1);
    firstResume.resolve(createThreadResult('thread-fork-target', [
      { id: 'checkpoint' },
      { id: 'later-turn' },
    ]));
    await disposing;
    const disposedEvents = await eventsPromise;
    expect(disposedEvents.at(-1)).toMatchObject({ type: 'cancelled' });
    expectPendingForkOwnershipEvent(disposedEvents);
    expectPendingForkOwnership(session, 'disposed');

    const disposedSnapshot = session.getSnapshot();
    const recreated = new CodexExecutionBackend(createPlugin()).createSession(
      createSessionConfig({
        resumeSeed: {
          providerSessionId: disposedSnapshot.providerSessionId,
          providerState: { ...disposedSnapshot.providerState },
        },
      }),
    );
    const retryEvents = await collectEvents(recreated.execute(createRequest()).events);

    expect(retryEvents.at(-1)).toMatchObject({ type: 'turn_completed' });
    expect(forkCount).toBe(1);
    expect(resumeCount).toBe(2);
    await recreated.dispose();
  });

  it('joins fork setup through process exit and retries the adopted child immediately', async () => {
    const firstResume = createDeferred<ReturnType<typeof createThreadResult>>();
    let resumeCount = 0;
    let forkCount = 0;
    mockTransportRequest.mockImplementation(async (method: string) => {
      if (method === 'initialize') {
        return {
          userAgent: 'test',
          codexHome: '/tmp/.codex',
          platformFamily: 'unix',
          platformOs: 'macos',
        };
      }
      if (method === 'thread/fork') {
        forkCount += 1;
        return createThreadResult('thread-fork-target', [
          { id: 'checkpoint' },
          { id: 'later-turn' },
        ]);
      }
      if (method === 'thread/resume') {
        resumeCount += 1;
        return resumeCount === 1
          ? firstResume.promise
          : createThreadResult('thread-fork-target', [
            { id: 'checkpoint' },
            { id: 'later-turn' },
          ]);
      }
      if (method === 'thread/rollback') {
        return createThreadResult('thread-fork-target', [{ id: 'checkpoint' }]);
      }
      if (method === 'turn/start') {
        queueMicrotask(() => completeTurn('thread-fork-target', 'turn-after-process-exit'));
        return createTurnResult('turn-after-process-exit');
      }
      throw new Error(`Unexpected method: ${method}`);
    });
    const session = new CodexExecutionBackend(createPlugin()).createSession(
      createForkSessionConfig(),
    );
    const run = session.execute(createRequest());
    const eventsPromise = collectEvents(run.events);
    await waitForCondition(() => resumeCount === 1);

    exitHandler?.();
    let exitSettled = false;
    void eventsPromise.then(() => { exitSettled = true; });
    await flushMicrotasks();

    expect(exitSettled).toBe(false);
    expect(mockTransportDispose).toHaveBeenCalledTimes(1);
    expect(mockProcessShutdown).toHaveBeenCalledTimes(1);
    expect(() => session.execute(createRequest())).toThrow(/active/i);
    firstResume.resolve(createThreadResult('thread-fork-target', [
      { id: 'checkpoint' },
      { id: 'later-turn' },
    ]));
    const exitedEvents = await eventsPromise;
    expect(exitedEvents.at(-1)).toMatchObject({
      type: 'execution_error',
      category: 'process-exited',
    });
    expectPendingForkOwnershipEvent(exitedEvents);
    expectPendingForkOwnership(session, 'invalidated');

    const retryEvents = await collectEvents(session.execute(createRequest()).events);

    expect(retryEvents.at(-1)).toMatchObject({ type: 'turn_completed' });
    expect(forkCount).toBe(1);
    expect(resumeCount).toBe(2);
    await session.dispose();
  });

  it.each(['cancellation', 'disposal'] as const)(
    'resolves an unknown fork identity before %s tears down its transport',
    async (lifecycle) => {
      const forkResult = createDeferred<ReturnType<typeof createThreadResult>>();
      let forkResponseDelivered = false;
      let forkCount = 0;
      let resumeCount = 0;
      const teardownSnapshots: unknown[] = [];
      mockTransportRequest.mockImplementation(async (method: string) => {
        if (method === 'initialize') {
          return {
            userAgent: 'test',
            codexHome: '/tmp/.codex',
            platformFamily: 'unix',
            platformOs: 'macos',
          };
        }
        if (method === 'thread/fork') {
          forkCount += 1;
          return forkResult.promise;
        }
        if (method === 'thread/resume') {
          resumeCount += 1;
          return createThreadResult('thread-fork-target', [
            { id: 'checkpoint' },
            { id: 'later-turn' },
          ]);
        }
        if (method === 'thread/rollback') {
          return createThreadResult('thread-fork-target', [{ id: 'checkpoint' }]);
        }
        if (method === 'turn/start') {
          queueMicrotask(() => completeTurn('thread-fork-target', 'turn-after-late-fork'));
          return createTurnResult('turn-after-late-fork');
        }
        throw new Error(`Unexpected method: ${method}`);
      });
      const session = new CodexExecutionBackend(createPlugin()).createSession(
        createForkSessionConfig(),
      );
      mockTransportDispose.mockImplementationOnce(() => {
        teardownSnapshots.push(session.getSnapshot());
        if (!forkResponseDelivered) {
          forkResult.reject(new Error('Transport disposed before fork identity was delivered'));
        }
      });
      const run = session.execute(createRequest());
      const eventsPromise = collectEvents(run.events);
      await waitForCondition(() => forkCount === 1);

      const lifecyclePromise = lifecycle === 'cancellation'
        ? (run.cancel(), eventsPromise.then(() => undefined))
        : session.dispose();
      let lifecycleSettled = false;
      void lifecyclePromise.then(() => { lifecycleSettled = true; });
      await flushMicrotasks();

      expect(lifecycleSettled).toBe(false);
      expect(mockTransportDispose).not.toHaveBeenCalled();
      expect(mockProcessShutdown).not.toHaveBeenCalled();

      forkResponseDelivered = true;
      forkResult.resolve(createThreadResult('thread-fork-target', [
        { id: 'checkpoint' },
        { id: 'later-turn' },
      ]));
      await lifecyclePromise;
      const lifecycleEvents = await eventsPromise;
      expect(lifecycleEvents.at(-1)).toMatchObject({ type: 'cancelled' });
      expectPendingForkOwnershipEvent(lifecycleEvents);
      expect(teardownSnapshots[0]).toMatchObject({
        providerSessionId: 'thread-fork-target',
        providerState: {
          forkSource: { sessionId: 'thread-source', resumeAt: 'checkpoint' },
          pendingForkTarget: { threadId: 'thread-fork-target' },
        },
      });
      expectPendingForkOwnership(
        session,
        lifecycle === 'disposal' ? 'disposed' : 'idle',
      );
      expect(mockTransportDispose).toHaveBeenCalledTimes(1);
      expect(mockProcessShutdown).toHaveBeenCalledTimes(1);
      expect(resumeCount).toBe(0);

      const retrySession = lifecycle === 'disposal'
        ? new CodexExecutionBackend(createPlugin()).createSession(
          createSessionConfig({
            resumeSeed: {
              providerSessionId: session.getSnapshot().providerSessionId,
              providerState: { ...session.getSnapshot().providerState },
            },
          }),
        )
        : session;
      const retryEvents = await collectEvents(
        retrySession.execute(createRequest()).events,
      );

      expect(retryEvents.at(-1)).toMatchObject({ type: 'turn_completed' });
      expect(forkCount).toBe(1);
      expect(resumeCount).toBe(1);
      await retrySession.dispose();
    },
  );

  it.each([
    ['passive', { kind: 'passive' }],
    ['read-only', { kind: 'read-only' }],
  ] as const)(
    'creates an ephemeral %s session with non-persistent strict policy',
    async (_name, toolPolicy) => {
      mockTransportRequest.mockImplementation(async (method: string) => {
        if (method === 'initialize') {
          return {
            userAgent: 'test',
            codexHome: '/tmp/.codex',
            platformFamily: 'unix',
            platformOs: 'macos',
          };
        }
        if (method === 'thread/start') return createThreadResult('thread-ephemeral');
        if (method === 'turn/start') {
          queueMicrotask(() => completeTurn('thread-ephemeral', 'turn-ephemeral'));
          return createTurnResult('turn-ephemeral');
        }
        throw new Error(`Unexpected method: ${method}`);
      });

      const session = new CodexExecutionBackend(createPlugin()).createSession(
        createSessionConfig({
          lifecycle: 'ephemeral',
          nativePersistence: 'disabled-if-supported',
        }),
      );

      await collectEvents(session.execute(createRequest(
        new AbortController().signal,
        { toolPolicy },
      )).events);

      expect(mockTransportRequest).toHaveBeenCalledWith(
        'thread/start',
        expect.objectContaining({
          persistExtendedHistory: false,
          approvalPolicy: 'never',
          sandbox: 'read-only',
        }),
      );
      expect(mockTransportRequest).toHaveBeenCalledWith(
        'turn/start',
        expect.objectContaining({
          approvalPolicy: 'never',
          sandboxPolicy: {
            type: 'readOnly',
            access: { type: 'fullAccess' },
            networkAccess: false,
          },
        }),
      );
      const startParams = mockTransportRequest.mock.calls.find(
        call => call[0] === 'thread/start',
      )?.[1];
      expect(startParams.dynamicTools).toBeUndefined();

      await session.dispose();
    },
  );

  it('fails closed before native startup when exact allow-list enforcement is unavailable', async () => {
    mockTransportRequest.mockImplementation(async (method: string) => {
      if (method === 'initialize') {
        return {
          userAgent: 'test',
          codexHome: '/tmp/.codex',
          platformFamily: 'unix',
          platformOs: 'macos',
        };
      }
      if (method === 'thread/start') return createThreadResult('thread-allow-list');
      if (method === 'turn/start') {
        queueMicrotask(() => completeTurn('thread-allow-list', 'turn-allow-list'));
        return createTurnResult('turn-allow-list');
      }
      throw new Error(`Unexpected method: ${method}`);
    });
    const session = new CodexExecutionBackend(createPlugin())
      .createSession(createSessionConfig());

    const events = await collectEvents(session.execute(createRequest(
      new AbortController().signal,
      {
        toolPolicy: {
          kind: 'allow-list',
          names: ['codex_app.load_workspace_dependencies'],
        },
      },
    )).events);

    expect(mockResolveLaunchSpec).not.toHaveBeenCalled();
    expect(mockProcessStart).not.toHaveBeenCalled();
    expect(mockTransportRequest).not.toHaveBeenCalled();
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        category: 'configuration',
        message: expect.stringContaining('allow-list'),
        recoverable: false,
        type: 'execution_error',
      }),
    ]));

    await session.dispose();
  });

  it('rejects concurrent requested runs synchronously', async () => {
    mockTransportRequest.mockImplementation(async (method: string) => {
      if (method === 'initialize') {
        return {
          userAgent: 'test',
          codexHome: '/tmp/.codex',
          platformFamily: 'unix',
          platformOs: 'macos',
        };
      }
      if (method === 'thread/start') return createThreadResult('thread-busy');
      if (method === 'turn/start') return createTurnResult('turn-busy');
      if (method === 'turn/interrupt') return {};
      throw new Error(`Unexpected method: ${method}`);
    });
    const session = new CodexExecutionBackend(createPlugin())
      .createSession(createSessionConfig());
    const first = session.execute(createRequest());

    expect(() => session.execute(createRequest())).toThrow(/active/i);

    first.cancel();
    await collectEvents(first.events);
    await session.dispose();
  });

  it('interrupts only the active native turn and terminates as cancelled', async () => {
    mockTransportRequest.mockImplementation(async (method: string) => {
      if (method === 'initialize') {
        return {
          userAgent: 'test',
          codexHome: '/tmp/.codex',
          platformFamily: 'unix',
          platformOs: 'macos',
        };
      }
      if (method === 'thread/start') return createThreadResult('thread-cancel');
      if (method === 'turn/start') return createTurnResult('turn-cancel');
      if (method === 'turn/interrupt') return {};
      throw new Error(`Unexpected method: ${method}`);
    });
    const session = new CodexExecutionBackend(createPlugin())
      .createSession(createSessionConfig());
    const run = session.execute(createRequest());

    await new Promise(resolve => setImmediate(resolve));
    run.cancel();
    const events = await collectEvents(run.events);

    expect(mockTransportRequest).toHaveBeenCalledWith(
      'turn/interrupt',
      { threadId: 'thread-cancel', turnId: 'turn-cancel' },
    );
    expect(events.at(-1)?.type).toBe('cancelled');

    await session.dispose();
  });

  it('quarantines a cancelled turn before its start response and fences its late events from retry', async () => {
    const firstTurnStart = createDeferred<ReturnType<typeof createTurnResult>>();
    const secondTurnStart = createDeferred<ReturnType<typeof createTurnResult>>();
    let initializeCount = 0;
    let turnStartCount = 0;
    mockTransportRequest.mockImplementation(async (method: string) => {
      if (method === 'initialize') {
        initializeCount += 1;
        return {
          userAgent: 'test',
          codexHome: '/tmp/.codex',
          platformFamily: 'unix',
          platformOs: 'macos',
        };
      }
      if (method === 'thread/start') return createThreadResult('thread-cancel-race');
      if (method === 'thread/resume') return createThreadResult('thread-cancel-race');
      if (method === 'turn/start') {
        turnStartCount += 1;
        return turnStartCount === 1
          ? firstTurnStart.promise
          : secondTurnStart.promise;
      }
      if (method === 'turn/interrupt') return {};
      throw new Error(`Unexpected method: ${method}`);
    });
    const session = new CodexExecutionBackend(createPlugin())
      .createSession(createSessionConfig());
    const firstRun = session.execute(createRequest());
    await waitForCondition(() => turnStartCount === 1);
    const oldTurnStarted = notificationHandlers.get('turn/started')!;
    const oldTextDelta = notificationHandlers.get('item/agentMessage/delta')!;

    firstRun.cancel();

    expect(() => session.execute(createRequest())).toThrow(/active/i);
    const firstEvents = await collectEvents(firstRun.events);
    expect(firstEvents.at(-1)?.type).toBe('cancelled');
    expect(mockTransportDispose).toHaveBeenCalledTimes(1);
    expect(mockProcessShutdown).toHaveBeenCalledTimes(1);

    const secondRun = session.execute(createRequest());
    await waitForCondition(() => turnStartCount === 2);
    oldTurnStarted({
      threadId: 'thread-cancel-race',
      turn: createTurnResult('turn-old').turn,
    });
    oldTextDelta({
      threadId: 'thread-cancel-race',
      turnId: 'turn-old',
      itemId: 'assistant-old',
      delta: 'late old output',
    });
    firstTurnStart.resolve(createTurnResult('turn-old'));
    secondTurnStart.resolve(createTurnResult('turn-new'));
    await waitForCondition(() => initializeCount === 2);
    await Promise.resolve();
    completeTurn('thread-cancel-race', 'turn-new');

    const secondEvents = await collectEvents(secondRun.events);
    expect(secondEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({
        accepted: true,
        nativeTurnId: 'turn-new',
        type: 'turn_started',
      }),
      expect.objectContaining({ type: 'turn_completed' }),
    ]));
    expect(secondEvents).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ nativeTurnId: 'turn-old' }),
      expect.objectContaining({ text: 'late old output' }),
    ]));
    expect(mockProcessStart).toHaveBeenCalledTimes(2);

    await session.dispose();
  });

  it.each([
    'process start',
    'transport start',
    'initialize',
  ] as const)(
    'cleans up exactly once when %s fails during app-server startup',
    async (failureBoundary) => {
      const failure = new Error(`Failed at ${failureBoundary}`);
      if (failureBoundary === 'process start') {
        mockProcessStart.mockImplementationOnce(() => {
          throw failure;
        });
      } else if (failureBoundary === 'transport start') {
        mockTransportStart.mockImplementationOnce(() => {
          throw failure;
        });
      }
      mockTransportRequest.mockImplementation(async (method: string) => {
        if (method === 'initialize') {
          if (failureBoundary === 'initialize') throw failure;
          return {
            userAgent: 'test',
            codexHome: '/tmp/.codex',
            platformFamily: 'unix',
            platformOs: 'macos',
          };
        }
        throw new Error(`Unexpected method: ${method}`);
      });
      const session = new CodexExecutionBackend(createPlugin())
        .createSession(createSessionConfig());

      const events = await collectEvents(session.execute(createRequest()).events);

      expect(events.at(-1)).toEqual(expect.objectContaining({
        message: expect.stringContaining(`Failed at ${failureBoundary}`),
        type: 'execution_error',
      }));
      expect(mockProcessShutdown).toHaveBeenCalledTimes(1);
      expect(mockTransportDispose).toHaveBeenCalledTimes(
        failureBoundary === 'process start' ? 0 : 1,
      );

      await session.dispose();
      expect(mockProcessShutdown).toHaveBeenCalledTimes(1);
      expect(mockTransportDispose).toHaveBeenCalledTimes(
        failureBoundary === 'process start' ? 0 : 1,
      );
    },
  );

  it('honors an already-aborted request without launching the app-server', async () => {
    const controller = new AbortController();
    controller.abort();
    const session = new CodexExecutionBackend(createPlugin())
      .createSession(createSessionConfig());

    const events = await collectEvents(
      session.execute(createRequest(controller.signal)).events,
    );

    expect(events.at(-1)?.type).toBe('cancelled');
    expect(mockProcessStart).not.toHaveBeenCalled();
    await session.dispose();
  });

  it('disposes idempotently, cancels the active run, and prevents later execution', async () => {
    mockTransportRequest.mockImplementation(async (method: string) => {
      if (method === 'initialize') {
        return {
          userAgent: 'test',
          codexHome: '/tmp/.codex',
          platformFamily: 'unix',
          platformOs: 'macos',
        };
      }
      if (method === 'thread/start') return createThreadResult('thread-dispose');
      if (method === 'turn/start') return createTurnResult('turn-dispose');
      if (method === 'turn/interrupt') return {};
      throw new Error(`Unexpected method: ${method}`);
    });
    const session = new CodexExecutionBackend(createPlugin())
      .createSession(createSessionConfig());
    const run = session.execute(createRequest());
    await new Promise(resolve => setImmediate(resolve));

    const firstDispose = session.dispose();
    const secondDispose = session.dispose();
    await Promise.all([firstDispose, secondDispose]);
    const events = await collectEvents(run.events);

    expect(events.at(-1)?.type).toBe('cancelled');
    expect(mockProcessShutdown).toHaveBeenCalledTimes(1);
    expect(session.getStatus()).toBe('disposed');
    expect(() => session.execute(createRequest())).toThrow(/disposed/i);
  });

  it('routes approvals and questions with stable local identities', async () => {
    const interactionPort = createInteractionPort();
    mockTransportRequest.mockImplementation(async (method: string) => {
      if (method === 'initialize') {
        return {
          userAgent: 'test',
          codexHome: '/tmp/.codex',
          platformFamily: 'unix',
          platformOs: 'macos',
        };
      }
      if (method === 'thread/start') return createThreadResult('thread-interaction');
      if (method === 'turn/start') {
        queueMicrotask(async () => {
          await serverRequestHandlers.get('item/commandExecution/requestApproval')?.(
            'approval-native',
            {
              threadId: 'thread-interaction',
              turnId: 'turn-interaction',
              itemId: 'command-item',
              command: 'pwd',
              cwd: '/vault',
            },
          );
          await serverRequestHandlers.get('item/tool/requestUserInput')?.(
            'question-native',
            {
              threadId: 'thread-interaction',
              turnId: 'turn-interaction',
              itemId: 'question-item',
              questions: [{
                id: 'choice',
                header: 'Choice',
                question: 'Continue?',
                options: null,
                isOther: false,
                isSecret: false,
              }],
            },
          );
          completeTurn('thread-interaction', 'turn-interaction');
        });
        return createTurnResult('turn-interaction');
      }
      throw new Error(`Unexpected method: ${method}`);
    });

    const session = new CodexExecutionBackend(createPlugin()).createSession(
      createSessionConfig({ interactionPort }),
    );
    await collectEvents(session.execute(createRequest()).events);

    const approvalRequest = (interactionPort.requestApproval as jest.Mock).mock.calls[0][0];
    const questionRequest = (interactionPort.askUserQuestion as jest.Mock).mock.calls[0][0];
    expect(approvalRequest).toEqual(expect.objectContaining({
      interactionId: expect.any(String),
      sessionInstanceId: session.sessionInstanceId,
      kind: 'approval',
      nativeContext: expect.objectContaining({ requestId: 'approval-native' }),
    }));
    expect(questionRequest).toEqual(expect.objectContaining({
      interactionId: expect.any(String),
      sessionInstanceId: session.sessionInstanceId,
      kind: 'question',
      nativeContext: expect.objectContaining({ requestId: 'question-native' }),
    }));
    expect(questionRequest.interactionId).not.toBe(approvalRequest.interactionId);

    await session.dispose();
  });

  it('normalizes process death into a terminal execution error and fences late output', async () => {
    mockTransportRequest.mockImplementation(async (method: string) => {
      if (method === 'initialize') {
        return {
          userAgent: 'test',
          codexHome: '/tmp/.codex',
          platformFamily: 'unix',
          platformOs: 'macos',
        };
      }
      if (method === 'thread/start') return createThreadResult('thread-death');
      if (method === 'turn/start') {
        queueMicrotask(() => exitHandler?.());
        return createTurnResult('turn-death');
      }
      throw new Error(`Unexpected method: ${method}`);
    });
    const session = new CodexExecutionBackend(createPlugin())
      .createSession(createSessionConfig());
    const events = await collectEvents(session.execute(createRequest()).events);

    expect(events.at(-1)).toEqual(expect.objectContaining({
      type: 'execution_error',
      category: 'process-exited',
    }));
    emitNotification('item/agentMessage/delta', {
      threadId: 'thread-death',
      turnId: 'turn-death',
      itemId: 'late',
      delta: 'late',
    });
    expect(events.some(event => event.type === 'text_delta' && event.text === 'late')).toBe(false);

    await session.dispose();
  });

  it('forwards request-scoped ultra effort and mode configuration on a later turn', async () => {
    let turnIndex = 0;
    mockTransportRequest.mockImplementation(async (method: string) => {
      if (method === 'initialize') {
        return {
          userAgent: 'test',
          codexHome: '/tmp/.codex',
          platformFamily: 'unix',
          platformOs: 'macos',
        };
      }
      if (method === 'thread/start') return createThreadResult('thread-config');
      if (method === 'turn/start') {
        turnIndex += 1;
        const turnId = `turn-config-${turnIndex}`;
        queueMicrotask(() => completeTurn('thread-config', turnId));
        return createTurnResult(turnId);
      }
      throw new Error(`Unexpected method: ${method}`);
    });
    const plugin = createPlugin();
    const codexConfig = (
      plugin.settings.providerConfigs as Record<string, Record<string, unknown>>
    ).codex;
    codexConfig.enableUltraEffort = true;
    codexConfig.discoveredModels = [
      {
        ...(codexConfig.discoveredModels as Array<Record<string, unknown>>)[0],
        supportedReasoningEfforts: [
          { value: 'high', description: 'Deep reasoning' },
          { value: 'ultra', description: 'Automatic task delegation' },
        ],
        defaultReasoningEffort: 'high',
      },
    ];
    const session = new CodexExecutionBackend(plugin).createSession(createSessionConfig());
    await collectEvents(session.execute(createRequest()).events);
    await collectEvents(session.execute(createRequest(
      new AbortController().signal,
      {
        configuration: {
          systemInstructions: { kind: 'explicit', instructions: 'Plan.' },
          model: TEST_CODEX_MODEL,
          reasoning: 'ultra',
          serviceTier: 'priority',
          permissionMode: 'yolo',
        },
      },
    )).events);

    const secondTurnParams = mockTransportRequest.mock.calls
      .filter(call => call[0] === 'turn/start')[1][1];
    expect(secondTurnParams).toEqual(expect.objectContaining({
      effort: 'ultra',
      collaborationMode: expect.objectContaining({
        settings: expect.objectContaining({ reasoning_effort: 'ultra' }),
      }),
      serviceTier: 'priority',
      approvalPolicy: 'never',
      sandboxPolicy: { type: 'dangerFullAccess' },
    }));

    await session.dispose();
  });

  it('validates saved ultra effort against the setting and auxiliary request model', async () => {
    let turnIndex = 0;
    mockTransportRequest.mockImplementation(async (method: string) => {
      if (method === 'initialize') {
        return {
          userAgent: 'test',
          codexHome: '/tmp/.codex',
          platformFamily: 'unix',
          platformOs: 'macos',
        };
      }
      if (method === 'thread/start') return createThreadResult('thread-auxiliary-effort');
      if (method === 'turn/start') {
        turnIndex += 1;
        const turnId = `turn-auxiliary-effort-${turnIndex}`;
        queueMicrotask(() => completeTurn('thread-auxiliary-effort', turnId));
        return createTurnResult(turnId);
      }
      throw new Error(`Unexpected method: ${method}`);
    });
    const plugin = createPlugin();
    const settings = plugin.settings as Record<string, unknown>;
    const providerConfigs = settings.providerConfigs as Record<string, Record<string, unknown>>;
    const currentCodexConfig = providerConfigs.codex;
    const currentModels = currentCodexConfig.discoveredModels as Array<Record<string, unknown>>;
    settings.savedProviderEffort = { codex: 'ultra' };
    providerConfigs.codex = {
      ...currentCodexConfig,
      enableUltraEffort: false,
      discoveredModels: [
        {
          ...currentModels[0],
          supportedReasoningEfforts: [
            { value: 'high', description: 'Deep reasoning' },
            { value: 'ultra', description: 'Automatic task delegation' },
          ],
          defaultReasoningEffort: 'high',
        },
        {
          ...currentModels[0],
          model: 'gpt-5.6-luna',
          displayName: 'GPT-5.6-Luna',
          supportedReasoningEfforts: [
            { value: 'low', description: 'Fast responses' },
            { value: 'medium', description: 'Balanced' },
          ],
          defaultReasoningEffort: 'medium',
          isDefault: false,
        },
      ],
    };
    const session = new CodexExecutionBackend(plugin).createSession(createSessionConfig());
    const createAuxiliaryRequest = (model: string): ProviderExecutionRequest => createRequest(
      new AbortController().signal,
      {
        configuration: {
          model,
          permissionMode: 'normal',
          systemInstructions: { kind: 'explicit', instructions: 'Be concise.' },
        },
      },
    );

    await collectEvents(session.execute(createAuxiliaryRequest(TEST_CODEX_MODEL)).events);
    providerConfigs.codex.enableUltraEffort = true;
    await collectEvents(session.execute(createAuxiliaryRequest('gpt-5.6-luna')).events);

    const turnParams = mockTransportRequest.mock.calls
      .filter(call => call[0] === 'turn/start')
      .map(call => call[1]);
    expect(turnParams[0]).toEqual(expect.objectContaining({
      model: TEST_CODEX_MODEL,
      effort: 'high',
      collaborationMode: expect.objectContaining({
        settings: expect.objectContaining({ reasoning_effort: 'high' }),
      }),
    }));
    expect(turnParams[1]).toEqual(expect.objectContaining({
      model: 'gpt-5.6-luna',
      effort: 'medium',
      collaborationMode: expect.objectContaining({
        settings: expect.objectContaining({ reasoning_effort: 'medium' }),
      }),
    }));

    await session.dispose();
  });

  it('preserves native compact and derives its turn ID from turn/started', async () => {
    mockTransportRequest.mockImplementation(async (method: string) => {
      if (method === 'initialize') {
        return {
          userAgent: 'test',
          codexHome: '/tmp/.codex',
          platformFamily: 'unix',
          platformOs: 'macos',
        };
      }
      if (method === 'thread/resume') return createThreadResult('thread-compact');
      if (method === 'thread/compact/start') {
        queueMicrotask(() => {
          emitNotification('turn/started', {
            threadId: 'thread-compact',
            turn: createTurnResult('turn-compact').turn,
          });
          completeTurn('thread-compact', 'turn-compact');
        });
        return {};
      }
      throw new Error(`Unexpected method: ${method}`);
    });
    const session = new CodexExecutionBackend(createPlugin()).createSession(
      createSessionConfig({
        resumeSeed: {
          providerSessionId: 'thread-compact',
          providerState: {
            threadId: 'thread-compact',
            nativeConversationContextEstablished: true,
          },
        },
      }),
    );
    const events = await collectEvents(session.execute(createRequest(
      new AbortController().signal,
      { input: [{ type: 'text', text: '/compact' }] },
    )).events);

    expect(mockTransportRequest).toHaveBeenCalledWith(
      'thread/compact/start',
      { threadId: 'thread-compact' },
    );
    expect(mockTransportRequest).not.toHaveBeenCalledWith(
      'turn/start',
      expect.anything(),
    );
    expect(events).toContainEqual(expect.objectContaining({
      type: 'turn_started',
      accepted: true,
      nativeTurnId: 'turn-compact',
    }));

    await session.dispose();
  });

  it('rejects compact before handoff while canonical history still needs recovery', async () => {
    const session = new CodexExecutionBackend(createPlugin()).createSession(
      createSessionConfig({
        resumeSeed: {
          providerSessionId: 'thread-recovery',
          providerState: {
            threadId: 'thread-recovery',
            nativeConversationContextEstablished: false,
          },
        },
      }),
    );
    const events = await collectEvents(session.execute(createRequest(
      new AbortController().signal,
      {
        input: [{ type: 'text', text: '/compact' }],
        conversationHistory: [
          {
            id: 'history-user',
            role: 'user',
            content: 'Prior question that still needs recovery.',
            timestamp: 1,
          },
          {
            id: 'history-assistant',
            role: 'assistant',
            content: 'Prior answer that still needs recovery.',
            timestamp: 2,
          },
        ],
      },
    )).events);

    expect(mockResolveLaunchSpec).not.toHaveBeenCalled();
    expect(mockProcessStart).not.toHaveBeenCalled();
    expect(mockTransportRequest).not.toHaveBeenCalled();
    expect(events).toContainEqual(expect.objectContaining({
      type: 'execution_error',
      category: 'configuration',
      recoverable: true,
      message: expect.stringContaining('native context'),
    }));
    expect(events).not.toContainEqual(expect.objectContaining({
      type: 'turn_started',
    }));
    expect(session.getSnapshot()).toMatchObject({
      providerSessionId: 'thread-recovery',
      status: 'idle',
      providerState: {
        threadId: 'thread-recovery',
        nativeConversationContextEstablished: false,
      },
    });

    await session.dispose();
  });

  it('preserves native tool item IDs and supports native thread steering', async () => {
    mockTransportRequest.mockImplementation(async (method: string) => {
      if (method === 'initialize') {
        return {
          userAgent: 'test',
          codexHome: '/tmp/.codex',
          platformFamily: 'unix',
          platformOs: 'macos',
        };
      }
      if (method === 'thread/start') return createThreadResult('thread-tools');
      if (method === 'turn/start') {
        queueMicrotask(() => {
          emitNotification('item/started', {
            threadId: 'thread-tools',
            turnId: 'turn-tools',
            item: {
              type: 'commandExecution',
              id: 'tool-native',
              command: 'pwd',
              cwd: '/vault',
              processId: '',
              source: '',
              status: 'inProgress',
              commandActions: [],
              aggregatedOutput: null,
              exitCode: null,
              durationMs: null,
            },
          });
        });
        return createTurnResult('turn-tools');
      }
      if (method === 'turn/steer') return { turnId: 'turn-tools' };
      if (method === 'turn/interrupt') return {};
      throw new Error(`Unexpected method: ${method}`);
    });
    const session = new CodexExecutionBackend(createPlugin())
      .createSession(createSessionConfig());
    const run = session.execute(createRequest());

    await new Promise(resolve => setImmediate(resolve));
    expect(isSteerableExecutionSession(session)).toBe(true);
    if (!isSteerableExecutionSession(session)) {
      throw new Error('Codex session should be steerable');
    }
    await expect(
      serverRequestHandlers.get('item/tool/call')?.('dynamic-request', {
        threadId: 'thread-tools',
        turnId: 'turn-tools',
        callId: 'dynamic-call',
        namespace: 'codex_app',
        tool: 'load_workspace_dependencies',
        arguments: {},
      }),
    ).resolves.toEqual(expect.objectContaining({
      success: false,
      contentItems: [expect.objectContaining({
        type: 'inputText',
        text: expect.stringContaining('unavailable'),
      })],
    }));
    await expect(session.steer(createRequest(
      new AbortController().signal,
      { input: [{ type: 'text', text: 'steer' }] },
    ))).resolves.toBe(true);
    run.cancel();
    const events = await collectEvents(run.events);

    expect(events).toContainEqual(expect.objectContaining({
      type: 'tool_started',
      toolCallId: 'tool-native',
      toolScope: { kind: 'main' },
    }));
    expect(mockTransportRequest).toHaveBeenCalledWith(
      'turn/steer',
      expect.objectContaining({
        threadId: 'thread-tools',
        expectedTurnId: 'turn-tools',
      }),
    );

    await session.dispose();
  });

  it('rejects an ambiguous steer failure after native handoff during lifecycle disposal', async () => {
    const steerResult = createDeferred<{ turnId: string }>();
    configureSteerTransport(
      'thread-steer-dispose',
      'turn-steer-dispose',
      () => steerResult.promise,
    );
    const { run, session } = await createActiveSteerSession();

    const steering = session.steer(createRequest(
      new AbortController().signal,
      { input: [{ type: 'text', text: 'redirect' }] },
    ));
    await waitForCondition(() => mockTransportRequest.mock.calls.some(
      ([method]) => method === 'turn/steer',
    ));
    const disposing = session.dispose();
    steerResult.reject(new Error('Transport disposed after steer handoff'));

    await expect(steering).rejects.toThrow(
      'Transport disposed after steer handoff',
    );
    await expect(disposing).resolves.toBeUndefined();
    await collectEvents(run.events);
  });

  it('keeps a matching native steer acknowledgement after the session becomes stale', async () => {
    const steerResult = createDeferred<{ turnId: string }>();
    configureSteerTransport(
      'thread-steer-stale',
      'turn-steer-stale',
      () => steerResult.promise,
    );
    const { run, session } = await createActiveSteerSession();

    const steering = session.steer(createRequest(
      new AbortController().signal,
      { input: [{ type: 'text', text: 'redirect' }] },
    ));
    await waitForCondition(() => mockTransportRequest.mock.calls.some(
      ([method]) => method === 'turn/steer',
    ));
    steerResult.resolve({ turnId: 'turn-steer-stale' });
    const disposing = session.dispose();

    await expect(steering).resolves.toBe(true);
    await expect(disposing).resolves.toBeUndefined();
    await collectEvents(run.events);
  });

  it.each([
    ['mismatched', { turnId: 'different-turn' }],
    ['malformed', {}],
  ])('rejects a %s native steer acknowledgement as ambiguous', async (
    _description,
    steerAcknowledgement,
  ) => {
    configureSteerTransport(
      'thread-steer-ack',
      'turn-steer-ack',
      () => steerAcknowledgement,
    );
    const { run, session } = await createActiveSteerSession();

    await expect(session.steer(createRequest(
      new AbortController().signal,
      { input: [{ type: 'text', text: 'redirect' }] },
    ))).rejects.toThrow('Codex returned an ambiguous steer acknowledgement.');

    run.cancel();
    await collectEvents(run.events);
    await session.dispose();
  });

  it('returns false for an explicit native steer rejection', async () => {
    configureSteerTransport('thread-steer-reject', 'turn-steer-reject', () => {
      throw new CodexRpcResponseError({
        code: -32602,
        message: 'Invalid steer parameters',
      });
    });
    const { run, session } = await createActiveSteerSession();

    await expect(session.steer(createRequest(
      new AbortController().signal,
      { input: [{ type: 'text', text: 'redirect' }] },
    ))).resolves.toBe(false);

    run.cancel();
    await collectEvents(run.events);
    await session.dispose();
  });

  it('rejects a native internal steer error as an ambiguous disposition', async () => {
    configureSteerTransport(
      'thread-steer-internal-error',
      'turn-steer-internal-error',
      () => {
        throw new CodexRpcResponseError({
          code: -32603,
          message: 'Internal error after steer dispatch',
        });
      },
    );
    const { run, session } = await createActiveSteerSession();

    await expect(session.steer(createRequest(
      new AbortController().signal,
      { input: [{ type: 'text', text: 'redirect' }] },
    ))).rejects.toThrow('Internal error after steer dispatch');

    run.cancel();
    await collectEvents(run.events);
    await session.dispose();
  });

  it('rejects a native steer timeout as an ambiguous disposition', async () => {
    configureSteerTransport('thread-steer-timeout', 'turn-steer-timeout', () => {
      throw new Error('Request timeout: turn/steer (30000ms)');
    });
    const { run, session } = await createActiveSteerSession();

    await expect(session.steer(createRequest(
      new AbortController().signal,
      { input: [{ type: 'text', text: 'redirect' }] },
    ))).rejects.toThrow('Request timeout: turn/steer (30000ms)');

    run.cancel();
    await collectEvents(run.events);
    await session.dispose();
  });

  it('returns false before native steer handoff when no active turn exists', async () => {
    const session = new CodexExecutionBackend(createPlugin())
      .createSession(createSessionConfig());
    if (!isSteerableExecutionSession(session)) {
      throw new Error('Codex session should be steerable');
    }

    await expect(session.steer(createRequest())).resolves.toBe(false);
    expect(mockTransportRequest).not.toHaveBeenCalledWith(
      'turn/steer',
      expect.anything(),
    );

    await session.dispose();
  });
});
