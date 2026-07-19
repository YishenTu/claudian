import '@/providers';

import { AcpClientConnection, AcpJsonRpcTransport, AcpSubprocess } from '@/providers/acp';
import { KimiAuxQueryRunner } from '@/providers/kimi/runtime/KimiAuxQueryRunner';

jest.mock('@/providers/acp', () => {
  const actual = jest.requireActual('@/providers/acp');
  return {
    ...actual,
    AcpClientConnection: jest.fn(),
    AcpJsonRpcTransport: jest.fn(),
    AcpSubprocess: jest.fn(),
  };
});

const MockAcpClientConnection = AcpClientConnection as jest.MockedClass<typeof AcpClientConnection>;
const MockAcpJsonRpcTransport = AcpJsonRpcTransport as jest.MockedClass<typeof AcpJsonRpcTransport>;
const MockAcpSubprocess = AcpSubprocess as jest.MockedClass<typeof AcpSubprocess>;

function createMockPlugin(overrides: Record<string, unknown> = {}): any {
  return {
    settings: {
      providerConfigs: {
        kimi: {
          enabled: true,
        },
      },
      model: 'kimi',
      ...((overrides.settings as Record<string, unknown> | undefined) ?? {}),
    },
    manifest: { version: '0.0.0-test' },
    getResolvedProviderCliPath: jest.fn().mockResolvedValue('/usr/local/bin/kimi'),
    app: {
      vault: {
        adapter: {
          basePath: '/tmp/claudian-kimi-aux-vault',
        },
      },
    },
    ...overrides,
  };
}

function createDeferred(): {
  promise: Promise<void>;
  resolve: () => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: () => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = () => res();
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('KimiAuxQueryRunner', () => {
  let mockConnection: {
    cancel: jest.Mock;
    dispose: jest.Mock;
    initialize: jest.Mock;
    newSession: jest.Mock;
    onSessionNotification: jest.Mock;
    prompt: jest.Mock;
    setConfigOption: jest.Mock;
  };
  let mockTransport: {
    dispose: jest.Mock;
    isClosed: boolean;
    start: jest.Mock;
  };
  let sessionNotificationListener: ((notification: any) => void | Promise<void>) | null;
  let processInstances: Array<{
    getStderrSnapshot: jest.Mock;
    isAlive: jest.Mock;
    onClose: jest.Mock;
    shutdown: jest.Mock;
    start: jest.Mock;
    stdin: Record<string, never>;
    stdout: Record<string, never>;
  }>;
  let shutdownDeferreds: Array<ReturnType<typeof createDeferred>>;

  beforeEach(() => {
    jest.clearAllMocks();
    sessionNotificationListener = null;
    processInstances = [];
    shutdownDeferreds = [];

    mockConnection = {
      cancel: jest.fn(),
      dispose: jest.fn(),
      initialize: jest.fn().mockResolvedValue({}),
      newSession: jest.fn().mockResolvedValue({ sessionId: 'aux-session-1', configOptions: [] }),
      onSessionNotification: jest.fn((listener) => {
        sessionNotificationListener = listener;
        return jest.fn();
      }),
      prompt: jest.fn().mockImplementation(async () => {
        await sessionNotificationListener?.({
          sessionId: 'aux-session-1',
          update: {
            content: { text: 'aux reply', type: 'text' },
            sessionUpdate: 'agent_message_chunk',
          },
        });
        return { stopReason: 'end_turn' };
      }),
      setConfigOption: jest.fn().mockResolvedValue({ configOptions: [] }),
    };
    mockTransport = {
      dispose: jest.fn(),
      isClosed: false,
      start: jest.fn(),
    };

    MockAcpClientConnection.mockImplementation(() => mockConnection as any);
    MockAcpJsonRpcTransport.mockImplementation(() => mockTransport as any);
    MockAcpSubprocess.mockImplementation(() => {
      const shutdownDeferred = createDeferred();
      shutdownDeferreds.push(shutdownDeferred);
      const instance = {
        getStderrSnapshot: jest.fn().mockReturnValue(''),
        isAlive: jest.fn().mockReturnValue(true),
        onClose: jest.fn().mockReturnValue(() => undefined),
        shutdown: jest.fn().mockImplementation(() => shutdownDeferred.promise),
        start: jest.fn(),
        stdin: {},
        stdout: {},
      };
      processInstances.push(instance);
      return instance as any;
    });
  });

  it('launches kimi acp and streams auxiliary text', async () => {
    // First process must shut down instantly if ensureReady restarts; initial start has none.
    const runner = new KimiAuxQueryRunner(createMockPlugin());

    await expect(runner.query({
      systemPrompt: 'Title helper',
    }, 'Summarize')).resolves.toBe('aux reply');

    expect(MockAcpSubprocess).toHaveBeenCalledWith(expect.objectContaining({
      args: ['acp'],
      command: '/usr/local/bin/kimi',
    }));
    expect(mockConnection.initialize).toHaveBeenCalled();
    expect(mockConnection.newSession).toHaveBeenCalledWith({
      cwd: expect.any(String),
      mcpServers: [],
    });
    expect(mockConnection.prompt).toHaveBeenCalledWith({
      prompt: [{ type: 'text', text: 'Title helper\n\nSummarize' }],
      sessionId: 'aux-session-1',
    });
  });

  it('awaits prior process shutdown before spawning after reset', async () => {
    const runner = new KimiAuxQueryRunner(createMockPlugin());

    // Start first process (no prior shutdown).
    shutdownDeferreds[0]?.resolve(); // no-op safety
    const firstQuery = runner.query({ systemPrompt: 'p' }, 'one');
    // Resolve any accidental shutdown from first path and let query complete.
    for (const deferred of shutdownDeferreds) {
      deferred.resolve();
    }
    await firstQuery;
    expect(MockAcpSubprocess).toHaveBeenCalledTimes(1);
    const firstProcess = processInstances[0]!;

    // Hold the first process shutdown so a subsequent start must wait.
    const heldShutdown = createDeferred();
    firstProcess.shutdown.mockImplementation(() => heldShutdown.promise);

    runner.reset();
    expect(firstProcess.shutdown).toHaveBeenCalledTimes(1);
    expect(MockAcpSubprocess).toHaveBeenCalledTimes(1);

    let secondQuerySettled = false;
    const secondQuery = runner.query({ systemPrompt: 'p' }, 'two').then((result) => {
      secondQuerySettled = true;
      return result;
    });

    // Allow microtasks to run; second spawn must still be blocked on shutdown.
    await Promise.resolve();
    await Promise.resolve();
    expect(secondQuerySettled).toBe(false);
    expect(MockAcpSubprocess).toHaveBeenCalledTimes(1);

    heldShutdown.resolve();
    await expect(secondQuery).resolves.toBe('aux reply');
    expect(MockAcpSubprocess).toHaveBeenCalledTimes(2);
    expect(processInstances[1]!.start).toHaveBeenCalled();
  });

  it('deduplicates concurrent reset shutdown onto one barrier', async () => {
    const runner = new KimiAuxQueryRunner(createMockPlugin());

    for (const deferred of shutdownDeferreds) {
      deferred.resolve();
    }
    await runner.query({ systemPrompt: 'p' }, 'warm');
    const firstProcess = processInstances[0]!;

    const heldShutdown = createDeferred();
    firstProcess.shutdown.mockImplementation(() => heldShutdown.promise);

    runner.reset();
    runner.reset();
    runner.reset();

    expect(firstProcess.shutdown).toHaveBeenCalledTimes(1);

    heldShutdown.resolve();
    await (runner as any).awaitShutdownBarrier();
    expect(firstProcess.shutdown).toHaveBeenCalledTimes(1);
  });

  it('cancels permission requests without approving tools', async () => {
    const runner = new KimiAuxQueryRunner(createMockPlugin());

    await expect((runner as any).handlePermissionRequest({
      options: [
        { kind: 'allow_once', name: 'Allow', optionId: 'approve_once' },
        { kind: 'reject_once', name: 'Reject', optionId: 'reject' },
      ],
      sessionId: 's1',
      toolCall: { title: 'Bash', toolCallId: 't1' },
    })).resolves.toEqual({
      outcome: { outcome: 'cancelled' },
    });
  });
});
