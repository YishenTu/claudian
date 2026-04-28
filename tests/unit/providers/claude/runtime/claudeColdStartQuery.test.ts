import * as sdkModule from '@anthropic-ai/claude-agent-sdk';

import { type ColdStartQueryConfig, runColdStartQuery } from '@/providers/claude/runtime/claudeColdStartQuery';

const sdkMock = sdkModule as unknown as {
  setMockMessages: (messages: any[], options?: { appendResult?: boolean }) => void;
  resetMockMessages: () => void;
  simulateCrash: (afterChunks?: number) => void;
  getLastOptions: () => sdkModule.Options | undefined;
};

// --- Mocks ---

jest.mock('@/utils/path', () => ({
  getVaultPath: jest.fn().mockReturnValue('/test/vault'),
}));

jest.mock('@/utils/env', () => ({
  parseEnvironmentVariables: jest.fn().mockReturnValue({ PATH: '/usr/bin' }),
  getEnhancedPath: jest.fn().mockReturnValue('/usr/bin:/mock/bin'),
  getMissingNodeError: jest.fn().mockReturnValue(null),
  findNodeExecutable: jest.fn().mockReturnValue('/usr/bin/node'),
}));

jest.mock('@/core/providers/ProviderSettingsCoordinator', () => ({
  ProviderSettingsCoordinator: {
    getProviderSettingsSnapshot: jest.fn().mockReturnValue({
      model: 'claude-sonnet-4-5',
      thinkingBudget: 'off',
      effortLevel: 'medium',
      loadUserClaudeSettings: false,
    }),
  },
}));

const { getVaultPath } = jest.requireMock('@/utils/path');
const { getMissingNodeError } = jest.requireMock('@/utils/env');

function createMockPlugin(overrides?: Partial<ColdStartQueryConfig['plugin']>) {
  return {
    app: {},
    settings: {},
    getResolvedProviderCliPath: jest.fn().mockReturnValue('/mock/claude'),
    getActiveEnvironmentVariables: jest.fn().mockReturnValue(''),
    ...overrides,
  } as unknown as ColdStartQueryConfig['plugin'];
}

function createConfig(overrides?: Partial<ColdStartQueryConfig>): ColdStartQueryConfig {
  return {
    plugin: createMockPlugin(),
    systemPrompt: 'Test system prompt',
    ...overrides,
  };
}

// --- Tests ---

beforeEach(() => {
  sdkMock.resetMockMessages();
  (getVaultPath as jest.Mock).mockReturnValue('/test/vault');
  (getMissingNodeError as jest.Mock).mockReturnValue(null);
});

describe('runColdStartQuery', () => {
  describe('happy path', () => {
    it('returns accumulated text and session ID', async () => {
      sdkMock.setMockMessages([
        { type: 'system', subtype: 'init', session_id: 'sess-42' },
        { type: 'assistant', message: { content: [{ type: 'text', text: 'Hello ' }] } },
        { type: 'assistant', message: { content: [{ type: 'text', text: 'World' }] } },
      ]);

      const result = await runColdStartQuery(createConfig(), 'hi');

      expect(result.text).toBe('Hello World');
      expect(result.sessionId).toBe('sess-42');
    });

    it('returns null sessionId when no init event', async () => {
      sdkMock.setMockMessages([
        { type: 'assistant', message: { content: [{ type: 'text', text: 'answer' }] } },
      ]);

      const result = await runColdStartQuery(createConfig(), 'hi');

      expect(result.sessionId).toBeNull();
    });
  });

  describe('infrastructure errors', () => {
    it('throws when vault path is null', async () => {
      (getVaultPath as jest.Mock).mockReturnValue(null);

      await expect(
        runColdStartQuery(createConfig(), 'hi')
      ).rejects.toThrow('Could not determine vault path');
    });

    it('throws when CLI path is null', async () => {
      const plugin = createMockPlugin({
        getResolvedProviderCliPath: jest.fn().mockReturnValue(null),
      });

      await expect(
        runColdStartQuery(createConfig({ plugin }), 'hi')
      ).rejects.toThrow('Claude CLI not found');
    });

    it('throws when node is missing', async () => {
      (getMissingNodeError as jest.Mock).mockReturnValue('Node.js not found');

      await expect(
        runColdStartQuery(createConfig(), 'hi')
      ).rejects.toThrow('Node.js not found');
    });
  });

  describe('SDK options', () => {
    it('passes system prompt, tools, and model to SDK', async () => {
      sdkMock.setMockMessages([
        { type: 'system', subtype: 'init', session_id: 'sess' },
      ]);

      await runColdStartQuery(
        createConfig({
          systemPrompt: 'Custom prompt',
          tools: [],
          model: 'claude-haiku-4-5',
        }),
        'hi',
      );

      const opts = sdkMock.getLastOptions();
      expect(opts?.systemPrompt).toBe('Custom prompt');
      expect(opts?.tools).toEqual([]);
      expect(opts?.model).toBe('claude-haiku-4-5');
      expect(opts?.permissionMode).toBe('bypassPermissions');
      expect(opts?.allowDangerouslySkipPermissions).toBe(true);
    });

    it('passes hooks to SDK', async () => {
      const hooks = { PreToolUse: [{ hooks: [jest.fn()] }] };
      sdkMock.setMockMessages([]);

      await runColdStartQuery(createConfig({ hooks }), 'hi');

      const opts = sdkMock.getLastOptions();
      expect(opts?.hooks).toBe(hooks);
    });

    it('passes auto mode opt-in when Claude safe mode is auto', async () => {
      sdkMock.setMockMessages([]);

      await runColdStartQuery(
        createConfig({
          providerSettings: {
            model: 'claude-sonnet-4-5',
            thinkingBudget: 'off',
            effortLevel: 'medium',
            loadUserClaudeSettings: false,
            providerConfigs: {
              claude: {
                safeMode: 'auto',
              },
            },
          },
        }),
        'hi',
      );

      expect(sdkMock.getLastOptions()?.extraArgs).toEqual({ 'enable-auto-mode': null });
    });

    it('sets persistSession false when configured', async () => {
      sdkMock.setMockMessages([]);

      await runColdStartQuery(createConfig({ persistSession: false }), 'hi');

      const opts = sdkMock.getLastOptions();
      expect(opts?.persistSession).toBe(false);
    });

    it('sets resume when resumeSessionId provided', async () => {
      sdkMock.setMockMessages([]);

      await runColdStartQuery(
        createConfig({ resumeSessionId: 'old-sess' }),
        'hi',
      );

      const opts = sdkMock.getLastOptions();
      expect(opts?.resume).toBe('old-sess');
    });

    it('does not set thinking when disabled', async () => {
      sdkMock.setMockMessages([]);

      await runColdStartQuery(
        createConfig({ thinking: { disabled: true } }),
        'hi',
      );

      const opts = sdkMock.getLastOptions();
      expect(opts?.thinking).toBeUndefined();
      expect(opts?.effort).toBeUndefined();
      expect(opts?.maxThinkingTokens).toBeUndefined();
    });

    it('uses provider settings model when no override', async () => {
      sdkMock.setMockMessages([]);

      await runColdStartQuery(createConfig(), 'hi');

      const opts = sdkMock.getLastOptions();
      expect(opts?.model).toBe('claude-sonnet-4-5');
    });

    it('clamps unsupported xhigh effort before calling the SDK', async () => {
      sdkMock.setMockMessages([]);

      await runColdStartQuery(
        createConfig({
          providerSettings: {
            model: 'claude-sonnet-4-5',
            thinkingBudget: 'off',
            effortLevel: 'xhigh',
            loadUserClaudeSettings: false,
          },
        }),
        'hi',
      );

      const opts = sdkMock.getLastOptions();
      expect(opts?.effort).toBe('high');
    });
  });

  describe('abort handling', () => {
    it('throws Cancelled when aborted mid-stream', async () => {
      const abortController = new AbortController();

      sdkMock.setMockMessages([
        { type: 'system', subtype: 'init', session_id: 'sess' },
        { type: 'assistant', message: { content: [{ type: 'text', text: 'partial' }] } },
      ]);

      // Abort before the query starts (signal will be checked on first iteration)
      abortController.abort();

      await expect(
        runColdStartQuery(createConfig({ abortController }), 'hi')
      ).rejects.toThrow('Cancelled');
    });
  });

  describe('SDK errors', () => {
    it('propagates SDK errors', async () => {
      sdkMock.simulateCrash(0);

      await expect(
        runColdStartQuery(createConfig(), 'hi')
      ).rejects.toThrow('Simulated consumer crash');
    });
  });

  describe('onTextChunk callback', () => {
    it('calls onTextChunk with accumulated text', async () => {
      const chunks: string[] = [];
      sdkMock.setMockMessages([
        { type: 'system', subtype: 'init', session_id: 'sess' },
        { type: 'assistant', message: { content: [{ type: 'text', text: 'Hello ' }] } },
        { type: 'assistant', message: { content: [{ type: 'text', text: 'World' }] } },
      ]);

      await runColdStartQuery(
        createConfig({ onTextChunk: (text) => chunks.push(text) }),
        'hi',
      );

      expect(chunks).toEqual(['Hello ', 'Hello World']);
    });
  });
});
