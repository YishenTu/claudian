import '@/providers';

import {
  AcpClientConnection,
  AcpJsonRpcTransport,
  AcpSubprocess,
  JsonRpcErrorResponse,
} from '@/providers/acp';
import {
  buildKimiAcpLaunchKey,
  formatKimiRuntimeError,
  isKimiAuthRequiredError,
  KIMI_AUTH_REQUIRED_MESSAGE,
  KimiChatRuntime,
} from '@/providers/kimi/runtime/KimiChatRuntime';

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
        kimi: {
          enabled: true,
        },
      },
      permissionMode: 'normal',
      model: 'kimi',
      effortLevel: 'off',
      mediaFolder: '',
      systemPrompt: '',
      userName: '',
      ...settingsOverride,
    },
    manifest: { version: '0.0.0-test' },
    getResolvedProviderCliPath: jest.fn().mockResolvedValue('/usr/local/bin/kimi'),
    saveSettings: jest.fn().mockResolvedValue(undefined),
    mutateSettings: jest.fn(async (mutation: (settings: any) => void | Promise<void>) => {
      await mutation((overrides.settings as any) ?? {});
    }),
    refreshModelSelectors: jest.fn(),
    app: {
      vault: {
        adapter: {
          basePath: '/tmp/claudian-kimi-test-vault',
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

describe('Kimi auth error helpers', () => {
  it('detects JSON-RPC -32000 authentication required', () => {
    const error = new JsonRpcErrorResponse('session/new', -32000, 'Authentication required');
    expect(isKimiAuthRequiredError(error)).toBe(true);
    expect(formatKimiRuntimeError(error)).toContain('kimi login');
    expect(formatKimiRuntimeError(error)).toBe(KIMI_AUTH_REQUIRED_MESSAGE);
  });
});

describe('Kimi permission fallback', () => {
  it('uses Kimi canonical approval option ids when the agent omits options', async () => {
    const runtime = new KimiChatRuntime(createMockPlugin());
    runtime.setApprovalCallback(jest.fn().mockResolvedValue('allow-always'));

    await expect((runtime as any).handlePermissionRequest({
      sessionId: 's1',
      toolCall: { title: 'Bash', rawInput: { command: 'pwd' } },
      options: [],
    })).resolves.toEqual({
      outcome: { optionId: 'approve_always', outcome: 'selected' },
    });
  });

  it('maps deny without options to the Kimi canonical reject optionId', async () => {
    const runtime = new KimiChatRuntime(createMockPlugin());
    runtime.setApprovalCallback(jest.fn().mockResolvedValue('deny'));

    await expect((runtime as any).handlePermissionRequest({
      sessionId: 's1',
      toolCall: { title: 'Bash', rawInput: { command: 'rm -rf /' } },
      options: [],
    })).resolves.toEqual({
      outcome: { optionId: 'reject', outcome: 'selected' },
    });
  });

  it('maps deny to the Kimi canonical reject option when agent advertises reject', async () => {
    const runtime = new KimiChatRuntime(createMockPlugin());
    runtime.setApprovalCallback(jest.fn().mockResolvedValue('deny'));

    await expect((runtime as any).handlePermissionRequest({
      sessionId: 's1',
      toolCall: { title: 'Bash', rawInput: { command: 'ls' } },
      options: [
        { optionId: 'approve_once', kind: 'allow_once', name: 'Approve once' },
        { optionId: 'approve_always', kind: 'allow_always', name: 'Approve for this session' },
        { optionId: 'reject', kind: 'reject_once', name: 'Reject' },
      ],
    })).resolves.toEqual({
      outcome: { optionId: 'reject', outcome: 'selected' },
    });
  });

  it('preserves every Plan Review choice as an exact select-option id', async () => {
    const runtime = new KimiChatRuntime(createMockPlugin());
    const approval = jest.fn().mockResolvedValue({
      type: 'select-option',
      value: 'plan_opt_1',
    });
    runtime.setApprovalCallback(approval);

    await expect((runtime as any).handlePermissionRequest({
      sessionId: 's1',
      toolCall: { title: 'ExitPlanMode', rawInput: {} },
      options: [
        { optionId: 'plan_opt_0', kind: 'allow_once', name: 'Path A' },
        { optionId: 'plan_opt_1', kind: 'allow_once', name: 'Path B' },
        { optionId: 'plan_revise', kind: 'reject_once', name: 'Revise' },
        { optionId: 'plan_reject_and_exit', kind: 'reject_once', name: 'Reject and Exit' },
      ],
    })).resolves.toEqual({
      outcome: { optionId: 'plan_opt_1', outcome: 'selected' },
    });
    expect(approval).toHaveBeenCalledWith(
      'ExitPlanMode',
      {},
      'Kimi Code wants to use ExitPlanMode.',
      {
        decisionOptions: [
          { label: 'Path A', value: 'plan_opt_0' },
          { label: 'Path B', value: 'plan_opt_1' },
          { label: 'Revise', value: 'plan_revise' },
          { label: 'Reject and Exit', value: 'plan_reject_and_exit' },
        ],
      },
    );
  });

  it('selects the exact advertised reject option id via select-option', async () => {
    const runtime = new KimiChatRuntime(createMockPlugin());
    const approval = jest.fn().mockResolvedValue({
      type: 'select-option',
      value: 'reject',
    });
    runtime.setApprovalCallback(approval);

    const response = await (runtime as any).handlePermissionRequest({
      sessionId: 's1',
      toolCall: { title: 'Bash', rawInput: { command: 'ls' } },
      options: [
        { optionId: 'approve_once', kind: 'allow_once', name: 'Approve once' },
        { optionId: 'approve_always', kind: 'allow_always', name: 'Approve for this session' },
        { optionId: 'reject', kind: 'reject_once', name: 'Reject' },
      ],
    });

    expect(response).toEqual({
      outcome: { optionId: 'reject', outcome: 'selected' },
    });
    expect(approval).toHaveBeenCalledWith(
      'Bash',
      { command: 'ls' },
      'Kimi Code wants to use Bash.',
      {
        decisionOptions: [
          { decision: 'allow', label: 'Approve once', value: 'approve_once' },
          { decision: 'allow-always', label: 'Approve for this session', value: 'approve_always' },
          // Reject intentionally omits `decision` so UI returns select-option.
          { label: 'Reject', value: 'reject' },
        ],
      },
    );
  });

  it('does not cancel when deny maps through reject_always kind', async () => {
    const runtime = new KimiChatRuntime(createMockPlugin());
    runtime.setApprovalCallback(jest.fn().mockResolvedValue('deny'));

    await expect((runtime as any).handlePermissionRequest({
      sessionId: 's1',
      toolCall: { title: 'Write', rawInput: { path: 'a.md' } },
      options: [
        { optionId: 'allow_once', kind: 'allow_once', name: 'Allow' },
        { optionId: 'reject_always', kind: 'reject_always', name: 'Reject always' },
      ],
    })).resolves.toEqual({
      outcome: { optionId: 'reject_always', outcome: 'selected' },
    });
  });
});

describe('buildKimiAcpLaunchKey', () => {
  it('tracks cli path, cwd, and env text', () => {
    const key = buildKimiAcpLaunchKey({
      cliPath: '/usr/local/bin/kimi',
      cwd: '/vault',
      envText: 'KIMI_CODE_HOME=/tmp/kimi',
    });
    expect(key).toContain('"/usr/local/bin/kimi"');
    expect(key).toContain('"/vault"');
    expect(key).toContain('KIMI_CODE_HOME');
  });
});

describe('KimiChatRuntime session lifecycle', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('creates a session, applies mode/model from config options, and streams text/tool/usage', async () => {
    const plugin = createMockPlugin({
      settings: {
        permissionMode: 'plan',
        model: 'kimi:kimi-code/k3',
      },
    });
    const runtime = new KimiChatRuntime(plugin);

    const setConfigOption = jest.fn().mockResolvedValue({
      configOptions: [
        {
          type: 'select',
          id: 'model',
          name: 'Model',
          category: 'model',
          currentValue: 'kimi-code/k3',
          options: [{ value: 'kimi-code/k3', name: 'K3' }],
        },
        {
          type: 'select',
          id: 'thinking',
          name: 'Thinking',
          category: 'thought_level',
          currentValue: 'off',
          options: [
            { value: 'off', name: 'Thinking Off' },
            { value: 'on', name: 'Thinking On' },
          ],
        },
        {
          type: 'select',
          id: 'mode',
          name: 'Mode',
          category: 'mode',
          currentValue: 'plan',
          options: [
            { value: 'default', name: 'Default' },
            { value: 'plan', name: 'Plan' },
            { value: 'yolo', name: 'YOLO' },
          ],
        },
      ],
    });
    const prompt = jest.fn().mockImplementation(async () => {
      await (runtime as any).handleSessionNotification({
        sessionId: 'sess-new',
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'hi' },
        },
      });
      await (runtime as any).handleSessionNotification({
        sessionId: 'sess-new',
        update: {
          sessionUpdate: 'agent_thought_chunk',
          content: { type: 'text', text: 'thinking...' },
        },
      });
      await (runtime as any).handleSessionNotification({
        sessionId: 'sess-new',
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'tc-1',
          title: 'Read',
          status: 'pending',
        },
      });
      await (runtime as any).handleSessionNotification({
        sessionId: 'sess-new',
        update: {
          sessionUpdate: 'plan',
          entries: [{ content: 'step 1', status: 'pending', priority: 'medium' }],
        },
      });
      await (runtime as any).handleSessionNotification({
        sessionId: 'sess-new',
        update: {
          sessionUpdate: 'available_commands_update',
          availableCommands: [{ name: 'compact', description: 'Compact' }],
        },
      });
      return { usage: { inputTokens: 1, outputTokens: 2 } };
    });
    const newSession = jest.fn().mockResolvedValue({
      sessionId: 'sess-new',
      configOptions: [
        {
          type: 'select',
          id: 'model',
          name: 'Model',
          category: 'model',
          currentValue: 'kimi-code/k3',
          options: [{ value: 'kimi-code/k3', name: 'K3' }],
        },
        {
          type: 'select',
          id: 'mode',
          name: 'Mode',
          category: 'mode',
          currentValue: 'default',
          options: [
            { value: 'default', name: 'Default' },
            { value: 'plan', name: 'Plan' },
          ],
        },
      ],
    });

    (runtime as any).connection = {
      newSession,
      loadSession: jest.fn(),
      setConfigOption,
      prompt,
      cancel: jest.fn(),
      dispose: jest.fn(),
    };
    (runtime as any).ready = true;
    (runtime as any).ensureReady = jest.fn().mockResolvedValue(true);

    const chunks: any[] = [];
    for await (const chunk of runtime.query(runtime.prepareTurn({ text: 'hello' } as any), [])) {
      chunks.push(chunk);
    }

    expect(newSession).toHaveBeenCalledWith({ cwd: expect.any(String), mcpServers: [] });
    expect(setConfigOption).toHaveBeenCalledWith(expect.objectContaining({
      configId: 'mode',
      value: 'plan',
    }));
    expect(prompt).toHaveBeenCalled();
    expect(chunks.some((chunk) => chunk.type === 'text' && chunk.content === 'hi')).toBe(true);
    expect(chunks.some((chunk) => chunk.type === 'thinking')).toBe(true);
    expect(chunks.some((chunk) => chunk.type === 'tool_call' || chunk.type === 'tool_use')).toBe(true);
    expect(chunks.some((chunk) => chunk.type === 'done')).toBe(true);
    expect(runtime.getSessionId()).toBe('sess-new');

    const commands = await runtime.getSupportedCommands();
    expect(commands.some((command) => command.name === 'compact')).toBe(true);
  });

  it('surfaces auth-required errors from session/new', async () => {
    const plugin = createMockPlugin();
    const runtime = new KimiChatRuntime(plugin);
    const newSession = jest.fn().mockRejectedValue(
      new JsonRpcErrorResponse('session/new', -32000, 'Authentication required'),
    );
    (runtime as any).connection = {
      newSession,
      dispose: jest.fn(),
    };

    await expect((runtime as any).createSession('/tmp/vault')).resolves.toBeNull();
    expect((runtime as any).lastSessionError).toContain('kimi login');
  });

  it('maps permission allow/reject decisions', async () => {
    const plugin = createMockPlugin();
    const runtime = new KimiChatRuntime(plugin);
    const approval = jest.fn().mockResolvedValue('allow');
    runtime.setApprovalCallback(approval);

    const allowResponse = await (runtime as any).handlePermissionRequest({
      sessionId: 's1',
      toolCall: { title: 'Bash', rawInput: { command: 'ls' } },
      options: [
        { optionId: 'allow_once', kind: 'allow_once', name: 'Allow' },
        { optionId: 'reject_once', kind: 'reject_once', name: 'Reject' },
      ],
    });
    expect(allowResponse).toEqual({
      outcome: { optionId: 'allow_once', outcome: 'selected' },
    });

    approval.mockResolvedValueOnce('deny');
    const denyResponse = await (runtime as any).handlePermissionRequest({
      sessionId: 's1',
      toolCall: { title: 'Bash', rawInput: { command: 'ls' } },
      options: [
        { optionId: 'allow_once', kind: 'allow_once', name: 'Allow' },
        { optionId: 'reject_once', kind: 'reject_once', name: 'Reject' },
      ],
    });
    expect(denyResponse).toEqual({
      outcome: { optionId: 'reject_once', outcome: 'selected' },
    });
  });

  it('skips setConfigOption when model/mode/thinking already match session state', async () => {
    const plugin = createMockPlugin({
      settings: {
        permissionMode: 'plan',
        model: 'kimi:kimi-code/k3',
        effortLevel: 'on',
      },
    });
    const runtime = new KimiChatRuntime(plugin);
    const setConfigOption = jest.fn().mockResolvedValue({});
    (runtime as any).connection = { setConfigOption };
    (runtime as any).currentSessionModelId = 'kimi-code/k3';
    (runtime as any).currentSessionModeId = 'plan';
    (runtime as any).currentSessionEffortConfigId = 'thinking';
    (runtime as any).currentSessionEffortValue = 'on';
    (runtime as any).currentSessionEffortValues = new Set(['off', 'on']);
    (runtime as any).resolveSelectedRawModelId = jest.fn().mockReturnValue('kimi-code/k3');
    (runtime as any).resolveSelectedModeId = jest.fn().mockReturnValue('plan');

    await (runtime as any).applySelectedModel('sess-1');
    await (runtime as any).applySelectedMode('sess-1');
    await (runtime as any).applySelectedEffort('sess-1');

    expect(setConfigOption).not.toHaveBeenCalled();
  });

  it('calls setConfigOption with model/thinking/mode when values change', async () => {
    const plugin = createMockPlugin({
      settings: {
        permissionMode: 'yolo',
        model: 'kimi:kimi-code/k3',
        effortLevel: 'on',
      },
    });
    const runtime = new KimiChatRuntime(plugin);
    const setConfigOption = jest.fn().mockResolvedValue({ configOptions: [] });
    (runtime as any).connection = { setConfigOption };
    (runtime as any).currentSessionModelId = 'kimi-code/old';
    (runtime as any).currentSessionModeId = 'default';
    (runtime as any).currentSessionEffortConfigId = 'thinking';
    (runtime as any).currentSessionEffortValue = 'off';
    (runtime as any).currentSessionEffortValues = new Set(['off', 'on']);
    (runtime as any).resolveSelectedRawModelId = jest.fn().mockReturnValue('kimi-code/k3');
    (runtime as any).resolveSelectedModeId = jest.fn().mockReturnValue('yolo');
    (runtime as any).syncSessionModelState = jest.fn().mockResolvedValue(undefined);
    (runtime as any).syncSessionModeState = jest.fn().mockResolvedValue(undefined);

    await (runtime as any).applySelectedModel('sess-1');
    await (runtime as any).applySelectedMode('sess-1');
    await (runtime as any).applySelectedEffort('sess-1');

    expect(setConfigOption).toHaveBeenCalledWith({
      configId: 'model',
      sessionId: 'sess-1',
      type: 'select',
      value: 'kimi-code/k3',
    });
    expect(setConfigOption).toHaveBeenCalledWith({
      configId: 'mode',
      sessionId: 'sess-1',
      type: 'select',
      value: 'yolo',
    });
    expect(setConfigOption).toHaveBeenCalledWith({
      configId: 'thinking',
      sessionId: 'sess-1',
      type: 'select',
      value: 'on',
    });
  });

  it('cancels an active turn and blocks overlapping queries until settle', async () => {
    const plugin = createMockPlugin();
    const runtime = new KimiChatRuntime(plugin);
    runtime.syncConversationState({
      id: 'conv-1',
      sessionId: 'sess-cancel',
      providerState: { sessionId: 'sess-cancel' },
    });

    const deferred = createDeferred<Record<string, never>>();
    const promptStarted = createDeferred();
    const cancel = jest.fn();
    const setConfigOption = jest.fn().mockResolvedValue({});
    const prompt = jest.fn().mockImplementation(() => {
      promptStarted.resolve();
      return deferred.promise;
    });

    (runtime as any).connection = {
      setConfigOption,
      prompt,
      cancel,
      dispose: jest.fn(),
    };
    (runtime as any).ready = true;
    (runtime as any).loadedSessionId = 'sess-cancel';
    (runtime as any).sessionId = 'sess-cancel';
    (runtime as any).ensureReady = jest.fn().mockResolvedValue(true);

    const firstQuery = (async () => {
      const chunks: unknown[] = [];
      for await (const chunk of runtime.query(runtime.prepareTurn({ text: 'first' } as any), [])) {
        chunks.push(chunk);
      }
      return chunks;
    })();

    await promptStarted.promise;
    runtime.cancel();
    expect(cancel).toHaveBeenCalledWith({ sessionId: 'sess-cancel' });
    expect((runtime as any).restartRequiredAfterCancel).toBe(true);
    expect((runtime as any).activeTurn).not.toBeNull();

    const overlap: unknown[] = [];
    for await (const chunk of runtime.query(runtime.prepareTurn({ text: 'second' } as any), [])) {
      overlap.push(chunk);
    }
    expect(overlap).toEqual([
      { type: 'error', content: 'Kimi Code does not support overlapping turns.' },
      { type: 'done' },
    ]);

    deferred.resolve({});
    await firstQuery;
    expect((runtime as any).activeTurn).toBeNull();
  });

  it('loads an existing session and cleans up deterministically', async () => {
    const plugin = createMockPlugin();
    const runtime = new KimiChatRuntime(plugin);
    const loadSession = jest.fn().mockResolvedValue({
      sessionId: 'sess-load',
      configOptions: [],
    });
    (runtime as any).connection = {
      loadSession,
      dispose: jest.fn(),
      newSession: jest.fn(),
      setConfigOption: jest.fn().mockResolvedValue({}),
    };

    await expect((runtime as any).loadSession('sess-load', '/tmp/vault')).resolves.toBe(true);
    expect(loadSession).toHaveBeenCalledWith({
      cwd: '/tmp/vault',
      mcpServers: [],
      sessionId: 'sess-load',
    });
    expect(runtime.getSessionId()).toBe('sess-load');

    runtime.cleanup();
    expect(runtime.isReady()).toBe(false);
  });

  it('persists kimiCodeHome in session updates', () => {
    const plugin = createMockPlugin();
    const runtime = new KimiChatRuntime(plugin);
    (runtime as any).sessionId = 'sess-1';
    (runtime as any).currentKimiCodeHome = '/custom/kimi-home';

    const result = runtime.buildSessionUpdates({
      conversation: null,
      sessionInvalidated: false,
    });

    expect(result.updates).toEqual({
      sessionId: 'sess-1',
      providerState: {
        sessionId: 'sess-1',
        kimiCodeHome: '/custom/kimi-home',
      },
    });
  });
});

describe('KimiChatRuntime process launch', () => {
  let mockConnection: {
    cancel: jest.Mock;
    dispose: jest.Mock;
    initialize: jest.Mock;
    loadSession: jest.Mock;
    newSession: jest.Mock;
    prompt: jest.Mock;
    setConfigOption: jest.Mock;
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
  let lastSubprocessLaunch: { args: string[]; command: string } | null;

  beforeEach(() => {
    jest.clearAllMocks();
    lastSubprocessLaunch = null;

    mockConnection = {
      cancel: jest.fn(),
      dispose: jest.fn(),
      initialize: jest.fn().mockResolvedValue({
        agentInfo: { name: 'Kimi Code CLI', version: '0.27.0' },
        agentCapabilities: { loadSession: true },
      }),
      loadSession: jest.fn().mockResolvedValue({ sessionId: 'sess-load' }),
      newSession: jest.fn().mockResolvedValue({ sessionId: 'sess-new', configOptions: [] }),
      prompt: jest.fn().mockResolvedValue({}),
      setConfigOption: jest.fn().mockResolvedValue({}),
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
      };
      return mockProcess as any;
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('spawns kimi acp and initializes the ACP connection', async () => {
    const plugin = createMockPlugin();
    const runtime = new KimiChatRuntime(plugin);
    await (runtime as any).startProcess({
      cliPath: '/usr/local/bin/kimi',
      cwd: '/tmp/vault',
    });

    expect(lastSubprocessLaunch).toEqual({
      args: ['acp'],
      command: '/usr/local/bin/kimi',
    });
    expect(mockProcess.start).toHaveBeenCalled();
    expect(mockConnection.initialize).toHaveBeenCalledWith({
      clientCapabilities: {
        fs: { readTextFile: true, writeTextFile: true },
      },
    });
  });

  it('includes image blocks in the prompt payload', async () => {
    const plugin = createMockPlugin();
    const runtime = new KimiChatRuntime(plugin);
    runtime.syncConversationState({
      id: 'c1',
      sessionId: 'sess-img',
      providerState: { sessionId: 'sess-img' },
    });
    const prompt = jest.fn().mockResolvedValue({});
    (runtime as any).connection = {
      prompt,
      setConfigOption: jest.fn().mockResolvedValue({}),
      cancel: jest.fn(),
      dispose: jest.fn(),
    };
    (runtime as any).ready = true;
    (runtime as any).loadedSessionId = 'sess-img';
    (runtime as any).sessionId = 'sess-img';
    (runtime as any).ensureReady = jest.fn().mockResolvedValue(true);

    for await (const chunk of runtime.query(runtime.prepareTurn({
      text: 'see image',
      images: [{ data: 'abc', mediaType: 'image/png' }],
    } as any), [])) {
      void chunk;
    }

    expect(prompt).toHaveBeenCalledWith(expect.objectContaining({
      prompt: expect.arrayContaining([
        { type: 'text', text: 'see image' },
        { type: 'image', data: 'abc', mimeType: 'image/png' },
      ]),
    }));
  });
});
