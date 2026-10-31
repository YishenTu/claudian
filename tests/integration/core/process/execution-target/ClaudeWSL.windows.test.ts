import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

import { createProviderHostFixture } from '@test/helpers/providerRuntimeHost';
import { WSL_CLAUDE_FIXTURE } from '@test/helpers/WSLClaudeFixture';

import { getInstallationKey } from '@/core/device/InstallationKey';
import { resolveExecutionTarget } from '@/core/process/execution-target/ExecutionTargetResolver';
import { buildTargetLaunchSpec } from '@/core/process/execution-target/TargetLaunchSpec';
import type { ExecutionTarget } from '@/core/process/execution-target/types';
import { createExecutionPathMapper } from '@/core/process/execution-target/WSLPathMapper';
import { runProcessProbe } from '@/core/process/ProcessProbe';
import { resolveClaudeHistoryContext } from '@/providers/claude/history/ClaudeHistoryContext';
import { getSDKSessionPath, readSDKSession } from '@/providers/claude/history/ClaudeHistoryPathResolver';
import { loadSubagentFinalResult } from '@/providers/claude/history/sdkSubagentSidecar';
import { inspectClaudeInstallation } from '@/providers/claude/runtime/ClaudeCLIInstallation';
import { ClaudeCLIResolver } from '@/providers/claude/runtime/ClaudeCLIResolver';
import { buildClaudeLaunchOptions, probeClaudeRuntime } from '@/providers/claude/runtime/probeClaudeRuntime';

async function nativeSDK() {
  const entry = createRequire(import.meta.url).resolve('@anthropic-ai/claude-agent-sdk');
  return await import(/* @vite-ignore */ pathToFileURL(entry).href) as typeof import('@anthropic-ai/claude-agent-sdk');
}
// The test alias points the SDK and its `/core` entry at the shared fake; this suite needs the installed SDK.
vi.mock('@anthropic-ai/claude-agent-sdk', async () => {
  const [{ createRequire: require }, { pathToFileURL: toURL }] = await Promise.all([import('node:module'), import('node:url')]);
  return import(/* @vite-ignore */ toURL(require(import.meta.url).resolve('@anthropic-ai/claude-agent-sdk')).href);
});

const target = process.platform === 'win32' ? resolveExecutionTarget({
  settings: { installationMethod: 'wsl', wslDistroOverride: '' },
}) : undefined;
let available = false;
if (target?.distroName) {
  try {
    execFileSync('wsl.exe', ['--distribution', target.distroName, '--exec', '/usr/bin/python3', '--version'], { timeout: 20_000, windowsHide: true });
    available = true;
  } catch { /* Native coverage requires a usable distro with the fixture interpreter. */ }
}
if (process.env.CLAUDIAN_REQUIRE_WSL === '1' && !available) throw new Error('Claude native WSL tests require WSL and python3');

describe.skipIf(!available)('Claude SDK on native Windows/WSL', { timeout: 60_000 }, () => {
  let hostVault: string;
  let linuxRoot: string;
  let hostRoot: string;
  let cli: string;
  let envBefore: NodeJS.ProcessEnv;
  const executionTarget = target as ExecutionTarget;
  const mapper = createExecutionPathMapper(executionTarget ?? { method: 'host-native', platformOs: 'linux', platformFamily: 'unix' });
  beforeAll(async () => {
    envBefore = { ...process.env };
    hostVault = await fs.mkdtemp(path.join(tmpdir(), 'claudian Claude WSL '));
    linuxRoot = `/tmp/claudian-claude-${randomUUID()}`;
    hostRoot = mapper.toHostPath(linuxRoot)!;
    cli = `${linuxRoot}/Claude Code/claude`;
    await fs.mkdir(path.win32.join(hostRoot, 'Claude Code'), { recursive: true });
    await fs.mkdir(path.win32.join(hostRoot, 'vault'));
    await fs.writeFile(mapper.toHostPath(cli)!, WSL_CLAUDE_FIXTURE);
    const spec = buildTargetLaunchSpec({ target: executionTarget, hostCwd: hostVault, env: {}, command: '/bin/chmod', args: ['+x', cli] });
    if (await runProcessProbe({ ...spec, cwd: spec.spawnCwd }, 20_000) === null) throw new Error('Unable to make the Claude fixture executable');
  });
  afterAll(async () => {
    if (hostRoot) await fs.rm(hostRoot, { recursive: true, force: true });
    if (hostVault) await fs.rm(hostVault, { recursive: true, force: true });
    // Restore in place: Vitest's env stubs keep a reference to the original object.
    if (envBefore) {
      for (const key of Object.keys(process.env)) if (!(key in envBefore)) delete process.env[key];
      Object.assign(process.env, envBefore);
    }
  });
  async function host(cwd: string, configDir?: string) {
    const key = getInstallationKey();
    const resolver = new ClaudeCLIResolver();
    const fixture = await createProviderHostFixture({
      settings: { providerConfigs: { claude: {
        installationMethodsByHost: { [key]: 'wsl' }, wslDistroOverridesByHost: { [key]: executionTarget.distroName ?? '' },
        cliPathsByHost: { [key]: cli },
        environmentVariables: [configDir && `CLAUDE_CONFIG_DIR=${configDir}`, 'CLAUDIAN_TEST_VALUE=quotes "$HOME"', 'ANTHROPIC_API_KEY=fixture-only'].filter(Boolean).join('\n'),
      } } },
      overrides: { workingDirectory: cwd,
        getResolvedProviderCliPath: async (_id, context) => resolver.resolveFromSettings(fixture.settings, context) },
    });
    return fixture.host.getRuntimeHost('claude');
  }

  it('detects a Linux executable with spaces and discovers metadata without inference', async () => {
    const runtimeHost = await host(hostVault);
    expect(await inspectClaudeInstallation(runtimeHost)).toMatchObject({ path: cli, version: '2.1.99', source: 'custom' });
    expect(await probeClaudeRuntime(runtimeHost)).toMatchObject({ models: [], commands: [], skills: [] });
  });

  it.each(['drive', 'unc'] as const)('preserves SDK argv and large stdin prompts for a %s vault, including the in-process MCP channel', async kind => {
    const sdk = await nativeSDK();
    const cwd = kind === 'drive' ? hostVault : path.win32.join(hostRoot, 'vault').replace('\\wsl$\\', '\\wsl.localhost\\');
    const configDir = path.win32.join(hostVault, '.claude');
    const runtimeHost = await host(cwd, configDir);
    const prompt = 'Long custom instruction.\n'.repeat(4_000);
    let calls = 0;
    await fs.writeFile(path.win32.join(hostVault, 'mcp.txt'), 'host-side session tool');
    const server = sdk.createSdkMcpServer({ name: 'fixture', tools: [sdk.tool('read_fixture', 'Read the fixture', {}, async () => {
      calls++;
      return { content: [{ type: 'text', text: await fs.readFile(path.win32.join(hostVault, 'mcp.txt'), 'utf8') }] };
    })] });
    const query = sdk.query({ prompt: 'Run the fixture', options: {
      ...buildClaudeLaunchOptions(runtimeHost, cwd, cli, { executionTarget }),
      systemPrompt: prompt, mcpServers: { fixture: server }, persistSession: false,
    } });
    let report: { cwd?: string; config?: string; home?: string; argv: string[]; mcp: { response: { mcp_response: { result: { content: unknown } } } } } | undefined;
    try {
      for await (const message of query) {
        if (message.type === 'assistant') {
          const text = message.message.content.find(block => block.type === 'text');
          if (text?.type === 'text') report = JSON.parse(text.text) as typeof report;
        }
        if (message.type === 'result') break;
      }
      expect(report).toMatchObject({ cwd: mapper.toTargetPath(cwd), config: mapper.toTargetPath(configDir),
        custom: 'quotes "$HOME"', auth: 'fixture-only', prompt: [prompt] });
      expect(report?.home).toMatch(/^\//);
      expect(report?.argv.join(' ')).not.toContain(prompt);
      expect(report?.mcp.response.mcp_response.result.content).toEqual([{ type: 'text', text: 'host-side session tool' }]);
      expect(calls).toBe(1);
    } finally { query.close(); }
  });

  it('reads Linux config/history and subagent files using the Linux project directory encoding', async () => {
    const runtimeHost = await host(hostVault, `${linuxRoot}/config`);
    const context = await resolveClaudeHistoryContext({ config: runtimeHost.config,
      environmentText: runtimeHost.environmentText, environment: { CLAUDE_CONFIG_DIR: `${linuxRoot}/config` }, hostPlatform: 'win32',
    }, hostVault);
    const sessionPath = getSDKSessionPath(hostVault, 'session-wsl', context);
    const expectedProject = mapper.toTargetPath(hostVault)!.replace(/[^a-zA-Z0-9]/g, '-');
    expect(sessionPath).toBe(path.win32.join(hostRoot, 'config', 'projects', expectedProject, 'session-wsl.jsonl'));
    await fs.mkdir(path.win32.dirname(sessionPath), { recursive: true });
    await fs.writeFile(sessionPath, JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'WSL transcript' }] } }) + '\n');
    expect((await readSDKSession(hostVault, 'session-wsl', context)).messages).toHaveLength(1);
    const sidecar = path.win32.join(path.win32.dirname(sessionPath), 'session-wsl', 'subagents', 'agent-worker.jsonl');
    await fs.mkdir(path.win32.dirname(sidecar), { recursive: true });
    await fs.writeFile(sidecar, JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'WSL subagent answer' }] } }) + '\n');
    expect(await loadSubagentFinalResult(hostVault, 'session-wsl', 'worker', undefined, context)).toBe('WSL subagent answer');
    const defaultContext = await resolveClaudeHistoryContext({ config: (await host(hostVault)).config, environment: {}, hostPlatform: 'win32' }, hostVault);
    expect(defaultContext?.environment?.CLAUDE_CONFIG_DIR).toBe(`${defaultContext?.environment?.HOME}/.claude`);
  });
});
