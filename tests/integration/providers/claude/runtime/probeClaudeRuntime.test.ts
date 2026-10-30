import * as path from 'node:path';

import type { Options, SDKControlInitializeResponse } from '@anthropic-ai/claude-agent-sdk';
import { DesktopVault } from '@test/helpers/core/DesktopVault';
import { createProviderHostFixture } from '@test/helpers/providerRuntimeHost';

const native = await vi.importActual<typeof import('@test/__mocks__/claude-agent-sdk')>('@anthropic-ai/claude-agent-sdk');

import type { ProviderRuntimeHost } from '@/core/providers/ProviderRuntimeHost';
import { buildClaudeLaunchOptions, probeClaudeRuntime } from '@/providers/claude/runtime/probeClaudeRuntime';

const initialization = {
  commands: [],
  models: [],
  agents: [],
  account: {},
  output_style: 'default',
  available_output_styles: [],
} as unknown as SDKControlInitializeResponse;

async function host(config: Record<string, unknown> = {}, environment = ''): Promise<ProviderRuntimeHost> {
  const fixture = await createProviderHostFixture({ vault,
    settings: { model: 'chat-model', sharedEnvironmentVariables: environment, providerConfigs: { claude: config } },
    overrides: { workingDirectory: '/vault', getResolvedProviderCliPath: async () => '/bin/claude' },
  });
  return fixture.host.getRuntimeHost('claude');
}

const sessionInit = { type: 'system', subtype: 'init', session_id: 'probe-session', skills: ['commit'] };

function nativeQuery(
  init: () => Promise<SDKControlInitializeResponse> = async () => initialization,
  messages: Array<Record<string, unknown> | Promise<unknown>> = [sessionInit],
) {
  native.setMockInitializationResult(init);
  native.setMockMessages(messages, { appendResult: false });
}

function lastLaunch(): { options: Options; prompt: unknown } {
  return { options: native.getLastOptions() as Options, prompt: native.getLastPrompt() };
}

let vault: DesktopVault;
beforeAll(async () => { vault = await DesktopVault.create(); });
afterAll(async () => { await vault.dispose(); });

beforeEach(() => { native.resetMockMessages(); });
afterEach(() => { vi.restoreAllMocks(); });

describe('Claude runtime probe', () => {
  it('reads the initialization answer and session-init skills, without a model or persisted session', async () => {
    nativeQuery();

    expect(await probeClaudeRuntime(await host())).toEqual({ ...initialization, skills: ['commit'] });

    const { options, prompt } = lastLaunch();
    expect(prompt).toBe('');
    expect(options.model).toBeUndefined();
    expect(options.persistSession).toBe(false);
    expect(native.getLastResponse()!.close).toHaveBeenCalledTimes(1);
  });

  it('includes MCP prompt commands that connect after the initialize answer but before session init', async () => {
    const commit = { name: 'commit', description: 'Create a commit', argumentHint: '' };
    const mcpPrompt = { name: 'mcp__docs__summarize', description: 'Summarize a doc', argumentHint: '<doc>' };
    nativeQuery(async () => ({ ...initialization, commands: [commit] }), [
      { type: 'system', subtype: 'commands_changed', commands: [commit, mcpPrompt] },
      sessionInit,
    ]);

    const result = await probeClaudeRuntime(await host());

    expect(result.commands).toEqual([commit, mcpPrompt]);
    expect(result.models).toBe(initialization.models);
  });

  it('rejects when the query ends before session init', async () => {
    nativeQuery(undefined, []);
    await expect(probeClaudeRuntime(await host())).rejects.toThrow('ended before initialization');
  });

  it.each([
    [{ loadUserSettings: false }, ['project', 'local'], { 'enable-auto-mode': null }],
    [{ loadUserSettings: true, enableChrome: true }, ['user', 'project', 'local'], { 'enable-auto-mode': null, chrome: null }],
  ])('launches with the runtime settings sources and flags for %o', async (config, settingSources, extraArgs) => {
    nativeQuery();
    await probeClaudeRuntime(await host(config));
    const { options } = lastLaunch();
    expect(options.settingSources).toEqual(settingSources);
    expect(options.extraArgs).toEqual(extraArgs);
  });

  it('bounds MCP startup unless the environment configures MCP_TIMEOUT', async () => {
    nativeQuery();
    await probeClaudeRuntime(await host({}, 'ANTHROPIC_BASE_URL=https://gateway.example\nPATH=/configured/bin'));
    expect(lastLaunch().options.env).toMatchObject({
      MCP_TIMEOUT: '5000', ANTHROPIC_BASE_URL: 'https://gateway.example',
    });

    expect(lastLaunch().options.env?.PATH?.split(path.delimiter)).toContain('/configured/bin');
    nativeQuery();
    await probeClaudeRuntime(await host({}, 'MCP_TIMEOUT=20000'));
    expect(lastLaunch().options.env?.MCP_TIMEOUT).toBe('20000');
  });

  it.each([
    [undefined, { name: 'AbortError' }],
    ['caller cancelled', { message: 'Claude Code runtime discovery cancelled', cause: 'caller cancelled' }],
  ])('aborts the SDK process and rejects with the caller reason (%s)', async (reason, expected) => {
    nativeQuery(undefined, [new Promise(() => undefined)]);
    let notifyStarted!: () => void;
    const started = new Promise<void>(resolve => { notifyStarted = resolve; });
    const query = native.query;
    vi.spyOn(native, 'query').mockImplementation(options => {
      const result = query(options);
      notifyStarted();
      return result;
    });
    const controller = new AbortController();
    const probe = probeClaudeRuntime(await host(), controller.signal);
    await started;

    controller.abort(reason);

    await expect(probe).rejects.toMatchObject(expected);
    expect(lastLaunch().options.abortController?.signal.aborted).toBe(true);
    expect(native.getLastResponse()!.close).toHaveBeenCalledTimes(1);
  });
});

describe('buildClaudeLaunchOptions', () => {
  it('reads setting sources from the Claude configuration', async () => {
    const options = buildClaudeLaunchOptions(await host({ loadUserSettings: false }), '/work', '/bin/claude');
    expect(options).toMatchObject({
      cwd: '/work', pathToClaudeCodeExecutable: '/bin/claude', settingSources: ['project', 'local'],
    });
    expect(options.env).not.toHaveProperty('MCP_TIMEOUT');
    expect(typeof options.spawnClaudeCodeProcess).toBe('function');
  });
});
