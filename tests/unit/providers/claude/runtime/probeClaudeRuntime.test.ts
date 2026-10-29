import type { Options, SDKControlInitializeResponse } from '@anthropic-ai/claude-agent-sdk';
import { runtimeHostFor } from '@test/helpers/providerRuntimeHost';

import type { ProviderRuntimeHost } from '@/core/providers/ProviderRuntimeHost';
import { buildClaudeLaunchOptions, probeClaudeRuntime } from '@/providers/claude/runtime/probeClaudeRuntime';

const mockQuery = vi.fn();
vi.mock('@/providers/claude/loadClaudeAgentSDK', () => ({ loadClaudeAgentQuery: async () => mockQuery }));
vi.mock('@/core/process/env', async () => ({
  ...(await vi.importActual<typeof import('@/core/process/env')>('@/core/process/env')), getEnhancedPath: () => '/enhanced/bin',
}));

const initialization = {
  commands: [],
  models: [],
  agents: [],
  account: {},
  output_style: 'default',
  available_output_styles: [],
} as unknown as SDKControlInitializeResponse;

function host(config: Record<string, unknown> = {}, environment = ''): ProviderRuntimeHost {
  return runtimeHostFor({
    settings: { model: 'chat-model', sharedEnvironmentVariables: environment, providerConfigs: { claude: config } },
    workingDirectory: '/vault',
    getResolvedProviderCliPath: vi.fn().mockResolvedValue('/bin/claude'),
  }, 'claude');
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
    initializationResult: vi.fn(init),
    supportedCommands: vi.fn(async () => latestCommands ?? (await init()).commands),
    supportedModels: vi.fn(),
    next: vi.fn(async () => {
      const value = pending.shift();
      if (!value) return { done: true, value: undefined };
      if (value.subtype === 'commands_changed') latestCommands = value.commands;
      return { done: false, value };
    }),
    close: vi.fn(),
  };
  mockQuery.mockReturnValue(conversation);
  return conversation;
}

function lastLaunch(): { options: Options; prompt: unknown } {
  return mockQuery.mock.calls.at(-1)![0] as { options: Options; prompt: unknown };
}

afterEach(() => { vi.clearAllMocks(); });

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
  it('reads setting sources from the Claude configuration', () => {
    const options = buildClaudeLaunchOptions(host({ loadUserSettings: false }), '/work', '/bin/claude');
    expect(options).toMatchObject({
      cwd: '/work', pathToClaudeCodeExecutable: '/bin/claude', settingSources: ['project', 'local'],
    });
    expect(options.env).not.toHaveProperty('MCP_TIMEOUT');
    expect(typeof options.spawnClaudeCodeProcess).toBe('function');
  });
});
