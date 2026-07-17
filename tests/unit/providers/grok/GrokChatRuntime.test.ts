import '@/providers';

import {
  AcpClientConnection,
  AcpJsonRpcTransport,
  AcpSubprocess,
} from '@/providers/acp';
import {
  buildGrokAcpLaunchKey,
  GrokChatRuntime,
} from '@/providers/grok/runtime/GrokChatRuntime';

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
  const settingsOverride = (overrides.settings as Record<string, unknown> | undefined) ?? {};
  const { settings: _ignoredSettings, ...restOverrides } = overrides;
  return {
    settings: {
      providerConfigs: {
        grok: {
          enabled: true,
          safeMode: 'workspace',
        },
      },
      permissionMode: 'normal',
      model: 'grok-4.5',
      effortLevel: 'high',
      mediaFolder: '',
      systemPrompt: '',
      userName: '',
      ...settingsOverride,
    },
    manifest: { version: '0.0.0-test' },
    getResolvedProviderCliPath: jest.fn().mockResolvedValue('/usr/local/bin/grok'),
    saveSettings: jest.fn().mockResolvedValue(undefined),
    app: {
      vault: {
        adapter: {
          basePath: '/tmp/claudian-grok-test-vault',
        },
      },
    },
    ...restOverrides,
  };
}

function createDeferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('buildGrokAcpLaunchKey', () => {
  it('includes safeMode and yolo but not full permissionMode', () => {
    const base = {
      cliPath: '/usr/local/bin/grok',
      cwd: '/vault',
      effort: 'high',
      envText: '',
      model: 'grok-4.5',
    };

    const workspaceNormal = buildGrokAcpLaunchKey({
      ...base,
      safeMode: 'workspace',
      yolo: false,
    });
    const readOnlyNormal = buildGrokAcpLaunchKey({
      ...base,
      safeMode: 'read-only',
      yolo: false,
    });
    const workspaceYolo = buildGrokAcpLaunchKey({
      ...base,
      safeMode: 'workspace',
      yolo: true,
    });

    expect(workspaceNormal).not.toEqual(readOnlyNormal);
    expect(workspaceNormal).not.toEqual(workspaceYolo);
    expect(workspaceNormal).toContain('"safeMode":"workspace"');
    expect(readOnlyNormal).toContain('"safeMode":"read-only"');
    expect(workspaceYolo).toContain('"yolo":true');
    expect(workspaceNormal).toContain('"yolo":false');
    // Plan vs normal share the same launch fingerprint (yolo false).
    expect(workspaceNormal).toEqual(buildGrokAcpLaunchKey({
      ...base,
      safeMode: 'workspace',
      yolo: false,
    }));
  });
});

describe('GrokChatRuntime session mode application', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('applies ACP plan mode after creating a session', async () => {
    const plugin = createMockPlugin({
      settings: {
        permissionMode: 'plan',
      },
    });
    const runtime = new GrokChatRuntime(plugin);
    const setMode = jest.fn().mockResolvedValue({});
    const newSession = jest.fn().mockResolvedValue({ sessionId: 'sess-new' });

    (runtime as any).connection = {
      newSession,
      setMode,
      loadSession: jest.fn(),
      dispose: jest.fn(),
    };

    const sessionId = await (runtime as any).createSession('/tmp/vault');

    expect(sessionId).toBe('sess-new');
    expect(newSession).toHaveBeenCalledWith({
      cwd: '/tmp/vault',
      mcpServers: [],
    });
    expect(setMode).toHaveBeenCalledWith({
      sessionId: 'sess-new',
      modeId: 'plan',
    });
    expect((runtime as any).currentSessionModeId).toBe('plan');
  });

  it('applies ACP default mode after loading a session for yolo', async () => {
    const plugin = createMockPlugin({
      settings: {
        permissionMode: 'yolo',
      },
    });
    const runtime = new GrokChatRuntime(plugin);
    const setMode = jest.fn().mockResolvedValue({});
    const loadSession = jest.fn().mockResolvedValue({ sessionId: 'sess-load' });

    (runtime as any).connection = {
      newSession: jest.fn(),
      setMode,
      loadSession,
      dispose: jest.fn(),
    };

    await expect((runtime as any).loadSession('sess-load', '/tmp/vault')).resolves.toBe(true);
    expect(loadSession).toHaveBeenCalledWith({
      cwd: '/tmp/vault',
      mcpServers: [],
      sessionId: 'sess-load',
    });
    expect(setMode).toHaveBeenCalledWith({
      sessionId: 'sess-load',
      modeId: 'default',
    });
  });

  it('does not commit session state when createSession setMode fails', async () => {
    const plugin = createMockPlugin({
      settings: {
        permissionMode: 'plan',
      },
    });
    const runtime = new GrokChatRuntime(plugin);
    const setMode = jest.fn().mockRejectedValue(new Error('setMode failed'));
    const newSession = jest.fn().mockResolvedValue({ sessionId: 'sess-new' });

    (runtime as any).connection = {
      newSession,
      setMode,
      loadSession: jest.fn(),
      dispose: jest.fn(),
    };

    await expect((runtime as any).createSession('/tmp/vault')).resolves.toBeNull();
    expect(setMode).toHaveBeenCalled();
    expect((runtime as any).sessionId).toBeNull();
    expect((runtime as any).loadedSessionId).toBeNull();
    expect((runtime as any).currentSessionModeId).toBeNull();
  });

  it('does not commit session state when loadSession setMode fails', async () => {
    const plugin = createMockPlugin({
      settings: {
        permissionMode: 'plan',
      },
    });
    const runtime = new GrokChatRuntime(plugin);
    const setMode = jest.fn().mockRejectedValue(new Error('setMode failed'));
    const loadSession = jest.fn().mockResolvedValue({ sessionId: 'sess-load' });

    (runtime as any).connection = {
      newSession: jest.fn(),
      setMode,
      loadSession,
      dispose: jest.fn(),
    };

    await expect((runtime as any).loadSession('sess-load', '/tmp/vault')).resolves.toBe(false);
    expect(setMode).toHaveBeenCalled();
    expect((runtime as any).sessionId).toBeNull();
    expect((runtime as any).loadedSessionId).toBeNull();
    expect((runtime as any).currentSessionModeId).toBeNull();
  });

  it('skips redundant setMode when the session already has the target mode', async () => {
    const plugin = createMockPlugin({
      settings: {
        permissionMode: 'plan',
      },
    });
    const runtime = new GrokChatRuntime(plugin);
    const setMode = jest.fn().mockResolvedValue({});
    (runtime as any).connection = { setMode };
    (runtime as any).currentSessionModeId = 'plan';

    await (runtime as any).applySessionMode('sess-1');
    expect(setMode).not.toHaveBeenCalled();
  });

  it('applies session mode before each prompt turn', async () => {
    const plugin = createMockPlugin({
      settings: {
        permissionMode: 'plan',
      },
    });
    const runtime = new GrokChatRuntime(plugin);
    runtime.syncConversationState({
      id: 'conv-1',
      sessionId: 'sess-turn',
      providerState: { sessionId: 'sess-turn' },
    });

    const setMode = jest.fn().mockResolvedValue({});
    const prompt = jest.fn().mockResolvedValue({});
    (runtime as any).connection = {
      setMode,
      prompt,
      cancel: jest.fn(),
      dispose: jest.fn(),
    };
    (runtime as any).ready = true;
    (runtime as any).loadedSessionId = 'sess-turn';
    (runtime as any).sessionId = 'sess-turn';
    (runtime as any).ensureReady = jest.fn().mockResolvedValue(true);

    const turn = runtime.prepareTurn({
      text: 'hello',
    } as any);

    const chunks: unknown[] = [];
    for await (const chunk of runtime.query(turn, [])) {
      chunks.push(chunk);
    }

    expect(setMode).toHaveBeenCalledWith({
      sessionId: 'sess-turn',
      modeId: 'plan',
    });
    expect(prompt).toHaveBeenCalled();
    expect(chunks.some((chunk) => (chunk as { type?: string }).type === 'done')).toBe(true);
  });

  it('persists resolved grokHome in session updates', () => {
    const plugin = createMockPlugin();
    const runtime = new GrokChatRuntime(plugin);
    (runtime as any).sessionId = 'sess-1';
    (runtime as any).currentGrokHome = '/custom/grok-home';

    const result = runtime.buildSessionUpdates({
      conversation: null,
      sessionInvalidated: false,
    });

    expect(result.updates).toEqual({
      sessionId: 'sess-1',
      providerState: {
        sessionId: 'sess-1',
        grokHome: '/custom/grok-home',
      },
    });
  });

  it('blocks overlapping query while a cancelled ACP prompt is still in flight', async () => {
    const plugin = createMockPlugin();
    const runtime = new GrokChatRuntime(plugin);
    runtime.syncConversationState({
      id: 'conv-1',
      sessionId: 'sess-cancel',
      providerState: { sessionId: 'sess-cancel' },
    });

    const deferred = createDeferred<Record<string, never>>();
    const promptStarted = createDeferred();
    const cancel = jest.fn();
    const setMode = jest.fn().mockResolvedValue({});
    const prompt = jest.fn().mockImplementation(() => {
      promptStarted.resolve();
      return deferred.promise;
    });

    (runtime as any).connection = {
      setMode,
      prompt,
      cancel,
      dispose: jest.fn(),
    };
    (runtime as any).ready = true;
    (runtime as any).loadedSessionId = 'sess-cancel';
    (runtime as any).sessionId = 'sess-cancel';
    (runtime as any).ensureReady = jest.fn().mockResolvedValue(true);

    const turn = runtime.prepareTurn({ text: 'first' } as any);
    const firstQuery = (async () => {
      const chunks: unknown[] = [];
      for await (const chunk of runtime.query(turn, [])) {
        chunks.push(chunk);
      }
      return chunks;
    })();

    await promptStarted.promise;
    expect(prompt).toHaveBeenCalledTimes(1);
    expect((runtime as any).activeTurn).not.toBeNull();

    runtime.cancel();
    expect(cancel).toHaveBeenCalledWith({ sessionId: 'sess-cancel' });
    // Busy barrier remains until the ACP prompt RPC settles.
    expect((runtime as any).activeTurn).not.toBeNull();
    expect((runtime as any).activeTurn.cancelled).toBe(true);

    const overlapChunks: unknown[] = [];
    for await (const chunk of runtime.query(runtime.prepareTurn({ text: 'second' } as any), [])) {
      overlapChunks.push(chunk);
    }
    expect(overlapChunks).toEqual([
      { type: 'error', content: 'Grok does not support overlapping turns.' },
      { type: 'done' },
    ]);
    expect(prompt).toHaveBeenCalledTimes(1);

    deferred.resolve({});
    await firstQuery;

    expect((runtime as any).activeTurn).toBeNull();

    // After the cancelled turn settles, a new query can start.
    const secondPrompt = jest.fn().mockResolvedValue({});
    (runtime as any).connection.prompt = secondPrompt;
    const postCancelChunks: unknown[] = [];
    for await (const chunk of runtime.query(runtime.prepareTurn({ text: 'third' } as any), [])) {
      postCancelChunks.push(chunk);
    }
    expect(secondPrompt).toHaveBeenCalledTimes(1);
    expect(postCancelChunks.some((chunk) => (chunk as { type?: string }).type === 'done')).toBe(true);
  });
});

describe('GrokChatRuntime process launch', () => {
  let mockConnection: {
    cancel: jest.Mock;
    dispose: jest.Mock;
    initialize: jest.Mock;
    loadSession: jest.Mock;
    newSession: jest.Mock;
    prompt: jest.Mock;
    setMode: jest.Mock;
  };
  let mockProcess: {
    getStderrSnapshot: jest.Mock;
    isAlive: jest.Mock;
    onClose: jest.Mock;
    shutdown: jest.Mock;
    start: jest.Mock;
    stdin: Record<string, never>;
    stdout: Record<string, never>;
  };
  let mockTransport: {
    dispose: jest.Mock;
    isClosed: boolean;
    onClose: jest.Mock;
    start: jest.Mock;
  };
  let lastSubprocessLaunch: { args: string[]; command: string; env: NodeJS.ProcessEnv } | null;

  beforeEach(() => {
    jest.clearAllMocks();
    lastSubprocessLaunch = null;

    mockConnection = {
      cancel: jest.fn(),
      dispose: jest.fn(),
      initialize: jest.fn().mockResolvedValue({}),
      loadSession: jest.fn().mockResolvedValue({ sessionId: 'sess-load' }),
      newSession: jest.fn().mockResolvedValue({ sessionId: 'sess-new' }),
      prompt: jest.fn().mockResolvedValue({}),
      setMode: jest.fn().mockResolvedValue({}),
    };
    mockProcess = {
      getStderrSnapshot: jest.fn().mockReturnValue(''),
      isAlive: jest.fn().mockReturnValue(true),
      onClose: jest.fn().mockReturnValue(() => undefined),
      shutdown: jest.fn().mockResolvedValue(undefined),
      start: jest.fn(),
      stdin: {},
      stdout: {},
    };
    mockTransport = {
      dispose: jest.fn(),
      isClosed: false,
      onClose: jest.fn().mockReturnValue(() => undefined),
      start: jest.fn(),
    };

    MockAcpClientConnection.mockImplementation(() => mockConnection as any);
    MockAcpJsonRpcTransport.mockImplementation(() => mockTransport as any);
    MockAcpSubprocess.mockImplementation((spec: any) => {
      lastSubprocessLaunch = {
        args: spec.args,
        command: spec.command,
        env: spec.env,
      };
      return mockProcess as any;
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('includes --always-approve in production YOLO launch args only', async () => {
    const yoloPlugin = createMockPlugin({
      settings: {
        permissionMode: 'yolo',
      },
    });
    const yoloRuntime = new GrokChatRuntime(yoloPlugin);
    await (yoloRuntime as any).startProcess({
      cliPath: '/usr/local/bin/grok',
      cwd: '/tmp/vault',
      effort: 'medium',
      model: 'grok-4.5',
      yolo: true,
    });

    expect(MockAcpSubprocess).toHaveBeenCalled();
    expect(lastSubprocessLaunch).not.toBeNull();
    expect(lastSubprocessLaunch!.args).toEqual([
      'agent',
      '-m',
      'grok-4.5',
      '--reasoning-effort',
      'medium',
      '--always-approve',
      'stdio',
    ]);
    expect(mockProcess.start).toHaveBeenCalled();
    expect(mockConnection.initialize).toHaveBeenCalled();

    lastSubprocessLaunch = null;
    const normalPlugin = createMockPlugin({
      settings: {
        permissionMode: 'normal',
      },
    });
    const normalRuntime = new GrokChatRuntime(normalPlugin);
    await (normalRuntime as any).startProcess({
      cliPath: '/usr/local/bin/grok',
      cwd: '/tmp/vault',
      effort: 'medium',
      model: 'grok-4.5',
      yolo: false,
    });

    expect(lastSubprocessLaunch).not.toBeNull();
    expect(lastSubprocessLaunch!.args).toEqual([
      'agent',
      '-m',
      'grok-4.5',
      '--reasoning-effort',
      'medium',
      'stdio',
    ]);
    expect(lastSubprocessLaunch!.args).not.toContain('--always-approve');
  });

  it('restarts ACP process when safeMode changes and keeps plan/normal on same process', async () => {
    const plugin = createMockPlugin({
      settings: {
        permissionMode: 'normal',
        providerConfigs: {
          grok: {
            enabled: true,
            safeMode: 'workspace',
          },
        },
      },
    });
    const runtime = new GrokChatRuntime(plugin);

    await expect(runtime.ensureReady({ allowSessionCreation: false })).resolves.toBe(true);
    expect(MockAcpSubprocess).toHaveBeenCalledTimes(1);
    expect(lastSubprocessLaunch?.env.GROK_SANDBOX).toBe('workspace');
    const firstLaunchKey = (runtime as any).currentLaunchKey as string;
    expect(firstLaunchKey).toContain('"safeMode":"workspace"');
    expect(firstLaunchKey).toContain('"yolo":false');

    // plan vs normal: launch key stays yolo:false → no process restart.
    plugin.settings.permissionMode = 'plan';
    await expect(runtime.ensureReady({ allowSessionCreation: false })).resolves.toBe(true);
    expect(MockAcpSubprocess).toHaveBeenCalledTimes(1);
    expect((runtime as any).currentLaunchKey).toBe(firstLaunchKey);

    // safeMode change: new launch key → restart with read-only sandbox env.
    plugin.settings.providerConfigs.grok.safeMode = 'read-only';
    await expect(runtime.ensureReady({ allowSessionCreation: false })).resolves.toBe(true);
    expect(MockAcpSubprocess).toHaveBeenCalledTimes(2);
    expect(mockProcess.shutdown).toHaveBeenCalled();
    expect(lastSubprocessLaunch?.env.GROK_SANDBOX).toBe('read-only');
    expect((runtime as any).currentLaunchKey).toContain('"safeMode":"read-only"');
    expect((runtime as any).currentLaunchKey).not.toBe(firstLaunchKey);

    // yolo requires restart for --always-approve.
    plugin.settings.permissionMode = 'yolo';
    await expect(runtime.ensureReady({ allowSessionCreation: false })).resolves.toBe(true);
    expect(MockAcpSubprocess).toHaveBeenCalledTimes(3);
    expect(lastSubprocessLaunch?.args).toContain('--always-approve');
    expect((runtime as any).currentLaunchKey).toContain('"yolo":true');
  });
});
