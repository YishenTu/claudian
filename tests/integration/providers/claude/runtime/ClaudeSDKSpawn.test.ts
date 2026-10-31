// @test-ci {"native":true}
import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

import type { SpawnOptions } from '@anthropic-ai/claude-agent-sdk';
import { WSL_CLAUDE_FIXTURE } from '@test/helpers/WSLClaudeFixture';
import { WSLProcessFixture,type WSLProcessRequest } from '@test/helpers/WSLProcessFixture';

import { buildClaudeLaunchOptions } from '@/providers/claude/runtime/probeClaudeRuntime';

vi.mock('child_process', async () => ({ ...await vi.importActual<typeof import('node:child_process')>('node:child_process'), spawn: vi.fn() }));

// Resolve outside Vite's SDK test alias: this contract must exercise the installed SDK.
// Restore in place: Vitest's env stubs keep a reference to the original object.
function restoreEnvironment(snapshot: NodeJS.ProcessEnv) {
  for (const key of Object.keys(process.env)) if (!(key in snapshot)) delete process.env[key];
  Object.assign(process.env, snapshot);
}
const environmentBeforeImport = { ...process.env };
afterAll(() => { restoreEnvironment(environmentBeforeImport); });
const sdkPath = createRequire(import.meta.url).resolve('@anthropic-ai/claude-agent-sdk');
const sdk = await import(/* @vite-ignore */ pathToFileURL(sdkPath).href) as typeof import('@anthropic-ai/claude-agent-sdk');

interface ControlMessage { type: string; request_id?: string; request?: { subtype: string; systemPrompt?: unknown } }
interface FixtureReport { prompt?: unknown; mcp?: { response: { mcp_response: { result: { content: unknown } } } } }

it('passes nonexistent Linux paths to the hook and sends a large system prompt over stdin', async () => {
  const previousEnv = { ...process.env };
  const native = new WSLProcessFixture();
  const messages: ControlMessage[] = [];
  let cli: WSLProcessRequest | undefined;
  native.reply = request => {
    cli = request;
    // A line-delimited peer: acknowledge each control request, as the CLI does.
    let pending = '';
    request.onStdin(chunk => {
      pending += chunk;
      const lines = pending.split('\n');
      pending = lines.pop()!;
      for (const line of lines.filter(Boolean)) {
        const message = JSON.parse(line) as ControlMessage;
        messages.push(message);
        if (message.type === 'control_request') request.write(JSON.stringify({
          type: 'control_response', response: { subtype: 'success', request_id: message.request_id,
            response: { commands: [], models: [], agents: [], available_output_styles: [] } },
        }) + '\n');
      }
    });
    return { hold: true };
  };
  vi.mocked(spawn).mockImplementation(native.spawn);
  const executionTarget = { method: 'wsl', platformOs: 'linux', platformFamily: 'unix', distroName: 'Ubuntu' } as const;
  const prompt = 'Large system instruction\n'.repeat(5_000);
  const launch = buildClaudeLaunchOptions({ config: {}, environmentText: '' }, 'C:\\does-not-exist', '/home/no-such-user/claude', { executionTarget });
  let received: SpawnOptions | undefined;
  const query = sdk.query({ prompt: '', options: { ...launch, systemPrompt: prompt,
    spawnClaudeCodeProcess: options => { received = options; return launch.spawnClaudeCodeProcess(options); },
  } });
  try {
    await query.initializationResult();
    expect(received).toMatchObject({ command: '/home/no-such-user/claude', cwd: '/mnt/c/does-not-exist' });
    expect(received?.args.join(' ')).not.toContain(prompt);
    expect(messages.find(message => message.request?.subtype === 'initialize')?.request?.systemPrompt).toEqual([prompt]);
    expect(native.requests).toHaveLength(1);
    expect(cli?.args.join(' ').length).toBeLessThan(32_767);
    expect(cli?.executable).toBe('/home/no-such-user/claude');
    expect(cli?.argv.join(' ')).not.toContain(prompt);
    expect(cli?.options).toMatchObject({ cwd: 'C:\\does-not-exist', windowsVerbatimArguments: true });
  } finally {
    query.close();
    restoreEnvironment(previousEnv);
    vi.mocked(spawn).mockReset();
  }
});

it('runs a Node-backed Linux CLI with the distro node and forwards Claude environment', async () => {
  const previousEnv = { ...process.env };
  const native = new WSLProcessFixture();
  native.reply = request => {
    request.onStdin(chunk => {
      for (const line of chunk.split('\n').filter(Boolean)) {
        const message = JSON.parse(line) as ControlMessage;
        if (message.type === 'control_request') request.write(JSON.stringify({
          type: 'control_response', response: { subtype: 'success', request_id: message.request_id,
            response: { commands: [], models: [], agents: [], available_output_styles: [] } },
        }) + '\n');
      }
    });
    return { hold: true };
  };
  vi.mocked(spawn).mockImplementation(native.spawn);
  process.env.ANTHROPIC_API_KEY = 'secret';
  const executionTarget = { method: 'wsl', platformOs: 'linux', platformFamily: 'unix', distroName: 'Ubuntu' } as const;
  const launch = buildClaudeLaunchOptions({ config: {}, environmentText: 'CUSTOM=hello' }, 'C:\\Vault', '/home/me/cli.js', { executionTarget });
  const query = sdk.query({ prompt: '', options: launch });
  try {
    await query.initializationResult();
    // The host Node path would not exist in the distro; the SDK's `node` resolves there.
    expect(native.requests.map(request => [request.executable, request.argv[0]])).toEqual([['node', '/home/me/cli.js']]);
    const [request] = native.requests;
    expect(String(request.options.env?.WSLENV).split(':')).toEqual(expect.arrayContaining(['CUSTOM', 'ANTHROPIC_API_KEY']));
    // Obsidian's cross-realm AbortSignal cannot reach Node's spawn; abort is handled manually.
    expect(request.options).not.toHaveProperty('signal');
  } finally {
    query.close();
    restoreEnvironment(previousEnv);
    vi.mocked(spawn).mockReset();
  }
});

it.skipIf(process.platform === 'win32')('exercises the native WSL fixture protocol and SDK MCP control channel with a local Unix process', async () => {
  const directory = await fs.mkdtemp(path.join(tmpdir(), 'claudian-sdk-fixture-'));
  const executable = path.join(directory, 'claude');
  await fs.writeFile(executable, WSL_CLAUDE_FIXTURE, { mode: 0o755 });
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  // The piped overload keeps non-null stdio streams, which is what the SDK's SpawnedProcess requires.
  const spawnPiped = (command: string, args: string[], options: import('node:child_process').SpawnOptionsWithStdioTuple<'pipe', 'pipe', 'pipe'>) =>
    actual.spawn(command, args, options);
  let calls = 0;
  const server = sdk.createSdkMcpServer({ name: 'fixture', tools: [sdk.tool('read_fixture', 'Read', {}, async () => {
    calls++;
    return { content: [{ type: 'text', text: 'in-process response' }] };
  })] });
  const prompt = 'long prompt '.repeat(5_000);
  let child: ReturnType<typeof spawnPiped> | undefined;
  const query = sdk.query({ prompt: 'Fixture request', options: {
    cwd: directory, pathToClaudeCodeExecutable: executable, systemPrompt: prompt,
    mcpServers: { fixture: server }, persistSession: false,
    spawnClaudeCodeProcess: options => {
      child = spawnPiped(options.command, options.args, { cwd: options.cwd, env: options.env, stdio: ['pipe', 'pipe', 'pipe'] });
      return child;
    },
  } });
  try {
    let report: FixtureReport | undefined;
    for await (const message of query) {
      if (message.type === 'assistant') {
        const block = message.message.content.find(item => item.type === 'text');
        if (block?.type === 'text') report = JSON.parse(block.text) as FixtureReport;
      }
      if (message.type === 'result') break;
    }
    expect(report?.prompt).toEqual([prompt]);
    expect(report?.mcp?.response.mcp_response.result.content).toEqual([{ type: 'text', text: 'in-process response' }]);
    expect(calls).toBe(1);
  } finally {
    query.close();
    child?.kill();
    await fs.rm(directory, { recursive: true, force: true });
  }
});
