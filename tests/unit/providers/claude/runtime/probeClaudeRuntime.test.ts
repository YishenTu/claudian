import type { Options, SDKControlInitializeResponse } from '@anthropic-ai/claude-agent-sdk';

import type { ProviderHost } from '@/core/providers/ProviderHost';
import { buildClaudeLaunchOptions, probeClaudeRuntime } from '@/providers/claude/runtime/probeClaudeRuntime';

const mockQuery = jest.fn();
jest.mock('@/providers/claude/loadClaudeAgentSDK', () => ({ loadClaudeAgentQuery: async () => mockQuery }));
jest.mock('@/utils/path', () => ({ ...jest.requireActual('@/utils/path'), getVaultPath: () => '/vault' }));
jest.mock('@/core/process/env', () => ({
  ...jest.requireActual('@/core/process/env'), getEnhancedPath: () => '/enhanced/bin',
}));

const initialization = {
  commands: [],
  models: [],
  agents: [],
  account: {},
  output_style: 'default',
  available_output_styles: [],
} as unknown as SDKControlInitializeResponse;

function host(config: Record<string, unknown> = {}, environment = ''): ProviderHost {
  return {
    app: {},
    settings: { model: 'chat-model', providerConfigs: { claude: config } },
    getResolvedProviderCliPath: jest.fn().mockResolvedValue('/bin/claude'),
    getActiveEnvironmentVariables: () => environment,
  } as unknown as ProviderHost;
}

const sessionInit = { type: 'system', subtype: 'init', session_id: 'probe-session', skills: ['commit'] };

/** Mirrors the SDK Query: `supportedCommands()` tracks the latest `commands_changed` push. */
function nativeQuery(
  init: () => Promise<SDKControlInitializeResponse> = async () => initialization,
  messages: Array<Record<string, unknown>> = [sessionInit],
) {
  const pending = [...messages];
  let latestCommands: unknown;
  const conversation = {
    initializationResult: jest.fn(init),
    supportedCommands: jest.fn(async () => latestCommands ?? (await init()).commands),
    supportedModels: jest.fn(),
    next: jest.fn(async () => {
      const value = pending.shift();
      if (!value) return { done: true, value: undefined };
      if (value.subtype === 'commands_changed') latestCommands = value.commands;
      return { done: false, value };
    }),
    close: jest.fn(),
  };
  mockQuery.mockReturnValue(conversation);
  return conversation;
}

function lastLaunch(): { options: Options; prompt: unknown } {
  return mockQuery.mock.calls.at(-1)![0] as { options: Options; prompt: unknown };
}

afterEach(() => { jest.clearAllMocks(); });

describe('Claude runtime probe', () => {
  it('reads the initialization answer and session-init skills, without a model or persisted session', async () => {
    const conversation = nativeQuery();

    expect(await probeClaudeRuntime(host())).toEqual({ ...initialization, skills: ['commit'] });

    const { options, prompt } = lastLaunch();
    expect(prompt).toBe('');
    expect(options.model).toBeUndefined();
    expect(options.persistSession).toBe(false);
    expect(conversation.close).toHaveBeenCalledTimes(1);
  });

  it('includes MCP prompt commands that connect after the initialize answer but before session init', async () => {
    const commit = { name: 'commit', description: 'Create a commit', argumentHint: '' };
    const mcpPrompt = { name: 'mcp__docs__summarize', description: 'Summarize a doc', argumentHint: '<doc>' };
    nativeQuery(async () => ({ ...initialization, commands: [commit] }), [
      { type: 'system', subtype: 'commands_changed', commands: [commit, mcpPrompt] },
      sessionInit,
    ]);

    const result = await probeClaudeRuntime(host());

    expect(result.commands).toEqual([commit, mcpPrompt]);
    expect(result.models).toBe(initialization.models);
  });

  it('rejects when the query ends before session init', async () => {
    nativeQuery(undefined, []);
    await expect(probeClaudeRuntime(host())).rejects.toThrow('ended before initialization');
  });

  it.each([
    [{ loadUserSettings: false }, ['project', 'local'], { 'enable-auto-mode': null }],
    [{ loadUserSettings: true, enableChrome: true }, ['user', 'project', 'local'], { 'enable-auto-mode': null, chrome: null }],
  ])('launches with the runtime settings sources and flags for %o', async (config, settingSources, extraArgs) => {
    nativeQuery();
    await probeClaudeRuntime(host(config));
    const { options } = lastLaunch();
    expect(options.settingSources).toEqual(settingSources);
    expect(options.extraArgs).toEqual(extraArgs);
  });

  it('bounds MCP startup unless the environment configures MCP_TIMEOUT', async () => {
    nativeQuery();
    await probeClaudeRuntime(host({}, 'ANTHROPIC_BASE_URL=https://gateway.example'));
    expect(lastLaunch().options.env).toMatchObject({
      MCP_TIMEOUT: '5000', ANTHROPIC_BASE_URL: 'https://gateway.example', PATH: '/enhanced/bin',
    });

    nativeQuery();
    await probeClaudeRuntime(host({}, 'MCP_TIMEOUT=20000'));
    expect(lastLaunch().options.env?.MCP_TIMEOUT).toBe('20000');
  });

  it.each([
    [undefined, { name: 'AbortError' }],
    ['caller cancelled', { message: 'Claude Code runtime discovery cancelled', cause: 'caller cancelled' }],
  ])('aborts the SDK process and rejects with the caller reason (%s)', async (reason, expected) => {
    const conversation = nativeQuery();
    conversation.next.mockImplementation(() => new Promise(() => undefined));
    const controller = new AbortController();
    const probe = probeClaudeRuntime(host(), controller.signal);
    for (let i = 0; i < 10 && !conversation.next.mock.calls.length; i++) {
      await new Promise<void>(resolve => setImmediate(resolve));
    }
    expect(conversation.next).toHaveBeenCalledTimes(1);

    controller.abort(reason);

    await expect(probe).rejects.toMatchObject(expected);
    expect(lastLaunch().options.abortController?.signal.aborted).toBe(true);
    expect(conversation.close).toHaveBeenCalledTimes(1);
  });
});

describe('buildClaudeLaunchOptions', () => {
  it('reads setting sources from the supplied settings snapshot', () => {
    const options = buildClaudeLaunchOptions(host({ loadUserSettings: true }), '/work', '/bin/claude', {
      settings: { providerConfigs: { claude: { loadUserSettings: false } } },
    });
    expect(options).toMatchObject({
      cwd: '/work', pathToClaudeCodeExecutable: '/bin/claude', settingSources: ['project', 'local'],
    });
    expect(options.env).not.toHaveProperty('MCP_TIMEOUT');
    expect(typeof options.spawnClaudeCodeProcess).toBe('function');
  });
});
