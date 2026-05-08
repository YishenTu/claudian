import '@/providers';

import { AcpClientConnection, AcpJsonRpcTransport, AcpSubprocess } from '@/providers/acp';
import { OpencodeAuxQueryRunner } from '@/providers/opencode/runtime/OpencodeAuxQueryRunner';
import { prepareOpencodeLaunchArtifacts } from '@/providers/opencode/runtime/OpencodeLaunchArtifacts';

jest.mock('@/providers/acp', () => {
  const actual = jest.requireActual('@/providers/acp');
  return {
    ...actual,
    AcpClientConnection: jest.fn(),
    AcpJsonRpcTransport: jest.fn(),
    AcpSubprocess: jest.fn(),
  };
});

jest.mock('@/providers/opencode/runtime/OpencodeLaunchArtifacts', () => {
  const actual = jest.requireActual('@/providers/opencode/runtime/OpencodeLaunchArtifacts');
  return {
    ...actual,
    prepareOpencodeLaunchArtifacts: jest.fn(),
  };
});

const MockAcpClientConnection = AcpClientConnection as jest.MockedClass<typeof AcpClientConnection>;
const MockAcpJsonRpcTransport = AcpJsonRpcTransport as jest.MockedClass<typeof AcpJsonRpcTransport>;
const MockAcpSubprocess = AcpSubprocess as jest.MockedClass<typeof AcpSubprocess>;
const mockPrepareOpencodeLaunchArtifacts = prepareOpencodeLaunchArtifacts as jest.MockedFunction<typeof prepareOpencodeLaunchArtifacts>;

function createMockPlugin(settings: Record<string, unknown> = {}) {
  return {
    settings: {
      model: 'opencode:openai/gpt-5',
      providerConfigs: {
        opencode: {
          enabled: true,
        },
      },
      settingsProvider: 'opencode',
      ...settings,
    },
    manifest: { version: '0.0.0-test' },
    getResolvedProviderCliPath: jest.fn().mockReturnValue('/usr/local/bin/opencode'),
    app: {
      vault: {
        adapter: {
          basePath: '/tmp/claudian-test-vault',
        },
      },
    },
  } as any;
}

describe('OpencodeAuxQueryRunner', () => {
  let mockConnection: {
    cancel: jest.Mock;
    dispose: jest.Mock;
    initialize: jest.Mock;
    newSession: jest.Mock;
    onSessionNotification: jest.Mock;
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
    start: jest.Mock;
  };
  let sessionNotificationListener: ((notification: any) => void | Promise<void>) | null;

  beforeEach(() => {
    jest.clearAllMocks();
    sessionNotificationListener = null;

    mockConnection = {
      cancel: jest.fn(),
      dispose: jest.fn(),
      initialize: jest.fn().mockResolvedValue({}),
      newSession: jest.fn().mockResolvedValue({ sessionId: 'session-1' }),
      onSessionNotification: jest.fn((listener) => {
        sessionNotificationListener = listener;
        return jest.fn();
      }),
      prompt: jest.fn().mockImplementation(async () => {
        await sessionNotificationListener?.({
          sessionId: 'session-1',
          update: {
            content: { text: 'Fix title', type: 'text' },
            messageId: 'assistant-1',
            sessionUpdate: 'agent_message_chunk',
          },
        });
        await sessionNotificationListener?.({
          sessionId: 'session-1',
          update: {
            content: { text: ' now', type: 'text' },
            messageId: 'assistant-1',
            sessionUpdate: 'agent_message_chunk',
          },
        });
        return { stopReason: 'end_turn' };
      }),
      setConfigOption: jest.fn().mockResolvedValue({ configOptions: [] }),
    };
    mockProcess = {
      getStderrSnapshot: jest.fn().mockReturnValue(''),
      isAlive: jest.fn().mockReturnValue(true),
      onClose: jest.fn(),
      shutdown: jest.fn().mockResolvedValue(undefined),
      start: jest.fn(),
      stdin: {},
      stdout: {},
    };
    mockTransport = {
      dispose: jest.fn(),
      start: jest.fn(),
    };

    MockAcpClientConnection.mockImplementation(() => mockConnection as any);
    MockAcpJsonRpcTransport.mockImplementation(() => mockTransport as any);
    MockAcpSubprocess.mockImplementation(() => mockProcess as any);
    mockPrepareOpencodeLaunchArtifacts.mockResolvedValue({
      configPath: '/tmp/claudian-opencode-aux/config.json',
      configContent: '{"default_agent":"claudian-aux-passive"}\n',
      databasePath: null,
      launchKey: 'launch-key',
      systemPromptPath: '/tmp/claudian-opencode-aux/system.md',
    });
  });

  it('launches an auxiliary ACP session and streams assistant text', async () => {
    const runner = new OpencodeAuxQueryRunner(createMockPlugin(), {
      agentProfile: 'passive',
      artifactPurpose: 'title-gen',
    });
    const onTextChunk = jest.fn();

    await expect(runner.query({
      onTextChunk,
      systemPrompt: 'Use this custom system prompt.',
    }, 'Generate a title')).resolves.toBe('Fix title now');

    expect(mockPrepareOpencodeLaunchArtifacts).toHaveBeenCalledWith(expect.objectContaining({
      artifactsSubdir: 'opencode/auxiliary/title-gen',
      defaultAgentId: 'claudian-aux-passive',
      managedAgents: [expect.objectContaining({ id: 'claudian-aux-passive' })],
      systemPromptKey: 'Use this custom system prompt.',
      systemPromptText: 'Use this custom system prompt.',
    }));
    expect(mockConnection.newSession).toHaveBeenCalledWith({
      cwd: '/tmp/claudian-test-vault',
      mcpServers: [],
    });
    expect(mockConnection.setConfigOption).toHaveBeenCalledWith({
      configId: 'mode',
      sessionId: 'session-1',
      type: 'select',
      value: 'claudian-aux-passive',
    });
    expect(mockConnection.setConfigOption).toHaveBeenCalledWith({
      configId: 'model',
      sessionId: 'session-1',
      type: 'select',
      value: 'openai/gpt-5',
    });
    expect(onTextChunk).toHaveBeenNthCalledWith(1, 'Fix title');
    expect(onTextChunk).toHaveBeenNthCalledWith(2, 'Fix title now');
  });

  it('falls back to opencode from PATH when no CLI path is configured', async () => {
    const plugin = createMockPlugin();
    plugin.getResolvedProviderCliPath.mockReturnValue(null);
    const runner = new OpencodeAuxQueryRunner(plugin, {
      agentProfile: 'passive',
      artifactPurpose: 'title-gen',
    });

    await expect(runner.query({
      systemPrompt: 'Use this custom system prompt.',
    }, 'Generate a title')).resolves.toBe('Fix title now');

    expect(MockAcpSubprocess).toHaveBeenCalledWith(expect.objectContaining({
      command: 'opencode',
    }));
  });

  it('uses an explicit encoded OpenCode model override from the active chat tab', async () => {
    mockConnection.newSession.mockResolvedValue({
      models: {
        availableModels: [
          { id: 'openai/gpt-4.1', name: 'GPT-4.1' },
          { id: 'openai/gpt-5.4', name: 'GPT-5.4' },
        ],
        currentModelId: 'openai/gpt-4.1',
      },
      sessionId: 'session-1',
    });

    const runner = new OpencodeAuxQueryRunner(createMockPlugin(), {
      agentProfile: 'passive',
      artifactPurpose: 'title-gen',
    });

    await expect(runner.query({
      model: 'opencode:openai/gpt-5.4',
      systemPrompt: 'Use this custom system prompt.',
    }, 'Generate a title')).resolves.toBe('Fix title now');

    expect(mockConnection.setConfigOption).toHaveBeenCalledWith({
      configId: 'model',
      sessionId: 'session-1',
      type: 'select',
      value: 'openai/gpt-5.4',
    });
    expect(mockConnection.setConfigOption).toHaveBeenCalledWith({
      configId: 'mode',
      sessionId: 'session-1',
      type: 'select',
      value: 'claudian-aux-passive',
    });
  });

  it('rejects permission prompts even for the read-only aux profile', async () => {
    const runner = new OpencodeAuxQueryRunner(createMockPlugin(), {
      agentProfile: 'readonly',
      artifactPurpose: 'inline',
      allowReadTextFile: true,
    });

    await expect((runner as any).handlePermissionRequest({
      options: [
        { kind: 'allow_once', name: 'Allow once', optionId: 'allow-now' },
        { kind: 'reject_once', name: 'Reject', optionId: 'reject-now' },
      ],
      sessionId: 'session-1',
      toolCall: {
        kind: 'read',
        rawInput: { path: 'note.md' },
        title: 'read',
        toolCallId: 'tool-1',
      },
    })).resolves.toEqual({
      outcome: {
        optionId: 'reject-now',
        outcome: 'selected',
      },
    });

    await expect((runner as any).handlePermissionRequest({
      options: [
        { kind: 'allow_once', name: 'Allow once', optionId: 'allow-now' },
        { kind: 'reject_once', name: 'Reject', optionId: 'reject-now' },
      ],
      sessionId: 'session-1',
      toolCall: {
        kind: 'edit',
        rawInput: { path: 'note.md' },
        title: 'edit',
        toolCallId: 'tool-2',
      },
    })).resolves.toEqual({
      outcome: {
        optionId: 'reject-now',
        outcome: 'selected',
      },
    });
  });

  it('rejects all permissions in deny-all mode', async () => {
    const runner = new OpencodeAuxQueryRunner(createMockPlugin(), {
      agentProfile: 'passive',
      artifactPurpose: 'instructions',
    });

    await expect((runner as any).handlePermissionRequest({
      options: [
        { kind: 'allow_once', name: 'Allow once', optionId: 'allow-now' },
        { kind: 'reject_once', name: 'Reject', optionId: 'reject-now' },
      ],
      sessionId: 'session-1',
      toolCall: {
        kind: 'read',
        rawInput: { path: 'note.md' },
        title: 'read',
        toolCallId: 'tool-1',
      },
    })).resolves.toEqual({
      outcome: {
        optionId: 'reject-now',
        outcome: 'selected',
      },
    });
  });

  it('rejects aux reads outside the workspace root', () => {
    const runner = new OpencodeAuxQueryRunner(createMockPlugin(), {
      agentProfile: 'readonly',
      artifactPurpose: 'inline',
      allowReadTextFile: true,
    });

    (runner as any).sessionCwds.set('session-1', '/tmp/claudian-test-vault');

    expect(() => (runner as any).resolveSessionPath('session-1', '/tmp/outside.md')).toThrow(
      'OpenCode aux read access is limited to the current workspace.',
    );
    expect((runner as any).resolveSessionPath('session-1', '/tmp/claudian-test-vault/notes/today.md')).toBe(
      '/tmp/claudian-test-vault/notes/today.md',
    );
  });
});
