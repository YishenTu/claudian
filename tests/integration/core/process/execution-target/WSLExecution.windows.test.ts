// @test-ci {"inputs":["src/{core/process/execution-target,providers/codex,providers/claude,providers/pi}/**","src/{core/providers/cli/TargetCLIInstallationProbe,core/providers/settings/InstallationSettings,shared/settings/ExecutionTargetSettings}*","tests/{unit,integration}/{core/process/execution-target,providers/codex,providers/claude,providers/pi}/**","tests/fixtures/providers/pi/**","tests/{unit,integration}/{core/providers/cli/TargetCLIInstallationProbe,core/providers/settings/InstallationSettings,shared/settings/ExecutionTargetSettings}*","tests/helpers/WSLClaudeFixture.ts"]}
import { execFileSync, spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { createChatFeatureHost } from '@test/helpers/features/chat/ChatFeatureHostFixture';
import { createSessionRuntimePool } from '@test/helpers/features/chat/SessionRuntimePoolHarness';
import { createProviderHostFixture } from '@test/helpers/providerRuntimeHost';
import { testDate } from '@test/helpers/testClock';
import { hasNativeWSL } from '@test/helpers/WSLNativeTarget';
import { WSL_LITERAL_ARGS, type WSLShellBehavior, wslShellFixtureFiles } from '@test/helpers/WSLShellFixture';

import { getInstallationKey } from '@/core/device/InstallationKey';
import { parseEnvironmentVariables } from '@/core/process/env';
import { resolveExecutionTarget, resolveExecutionTargetAsync } from '@/core/process/execution-target/ExecutionTargetResolver';
import { probeTargetEnvironment } from '@/core/process/execution-target/TargetEnvironmentProbe';
import { buildTargetLaunchSpec } from '@/core/process/execution-target/TargetLaunchSpec';
import type { ExecutionTarget, TargetLaunchSpec } from '@/core/process/execution-target/types';
import { createExecutionPathMapper } from '@/core/process/execution-target/WSLPathMapper';
import { runProcessProbe } from '@/core/process/ProcessProbe';
import { probeTargetCLIInstallation } from '@/core/providers/cli/TargetCLIInstallationProbe';
import type { ProviderRuntimeHost } from '@/core/providers/ProviderRuntimeHost';
import { createClaudianAPI } from '@/features/chat/session-messaging/ClaudianAPI';
import { SessionMessagingService } from '@/features/chat/session-messaging/SessionMessagingService';
import { decodePiConfig } from '@/providers/pi/config';
import { PiCommandMetadataProbe } from '@/providers/pi/execution/PiCommandMetadataProbe';
import { PiRPCSessionKernel } from '@/providers/pi/execution/PiExecutionKernel';
import { PiConversationHistoryService } from '@/providers/pi/history/PiConversationHistoryService';
import { createPiForkSessionFile, readPiSessionEntries } from '@/providers/pi/history/PiHistoryStore';
import { inspectPiInstallation } from '@/providers/pi/runtime/PiCLIInstallation';
import { PiCLIResolver } from '@/providers/pi/runtime/PiCLIResolver';
import { buildPiLaunchSpec } from '@/providers/pi/runtime/PiLaunchSpecBuilder';
import { PiModelDiscoveryService } from '@/providers/pi/runtime/PiModelDiscoveryService';
import { piHostPath, piTargetPath } from '@/providers/pi/runtime/piTargetPaths';

const settings = { installationMethod: 'wsl' as const, wslDistroOverride: '' };
const available = hasNativeWSL();
const target = available ? resolveExecutionTarget({ settings }) : null;

const shells = ['bash', 'zsh', 'csh', 'tcsh', 'fish'];
const installedShells = new Set(shells.filter(shell => {
  if (!available) return false;
  try {
    execFileSync('wsl.exe', ['--distribution', target!.distroName!, '--exec', '/usr/bin/test', '-x', `/bin/${shell}`], { timeout: 20_000, windowsHide: true });
    return true;
  } catch { return false; }
}));
if (process.env.CLAUDIAN_REQUIRE_WSL === '1' && installedShells.size !== shells.length) {
  throw new Error('The WSL CI job must install bash, zsh, csh, tcsh and fish.');
}

function probe(spec: TargetLaunchSpec) {
  return runProcessProbe({ ...spec, cwd: spec.spawnCwd }, 20_000);
}

describe.skipIf(!available)('native Windows to WSL execution', { timeout: 60_000 }, () => {
  let hostCwd: string;
  let resolvedTarget: ExecutionTarget;
  let env: Record<string, string>;
  beforeAll(async () => {
    resolvedTarget = target!;
    hostCwd = await fs.mkdtemp(path.join(tmpdir(), 'claudian WSL '));
    env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  });
  afterAll(async () => { if (hostCwd) await fs.rm(hostCwd, { recursive: true, force: true }); });

  describe('Pi adoption with a Linux-only fixture CLI', () => {
    let linuxRoot: string;
    let command: string;
    let sessionFile: string;
    let piConfig: Record<string, unknown>;
    let piHost: ProviderRuntimeHost;
    beforeAll(async () => {
      linuxRoot = (await probe(buildTargetLaunchSpec({ target: resolvedTarget, hostCwd, env, command: 'mktemp', args: ['-d', '/tmp/claudian-pi-XXXXXX'] })))!.trim();
      const mapper = createExecutionPathMapper(resolvedTarget);
      const fixtureRoot = mapper.toHostPath(linuxRoot)!;
      for (const name of ['PiSessionProcess.mjs', 'PiSessionManager.mjs']) {
        await fs.copyFile(path.resolve('tests/fixtures/providers/pi', name), path.join(fixtureRoot, name));
      }
      command = `${linuxRoot}/pi`;
      await fs.writeFile(path.join(fixtureRoot, 'pi'), '#!/bin/sh\nexec node "$(dirname "$0")/PiSessionProcess.mjs" "$@"\n');
      await probe(buildTargetLaunchSpec({ target: resolvedTarget, hostCwd, env, command: 'chmod', args: ['+x', command] }));
      // Fail setup with the interpreter's stderr instead of an opaque null probe/RPC close.
      const fixtureVersion = execFileSync('wsl.exe', [
        '--distribution', resolvedTarget.distroName!, '--exec', '/usr/bin/env', 'node', `${linuxRoot}/PiSessionProcess.mjs`, '--version',
      ], { encoding: 'utf8', timeout: 20_000, windowsHide: true });
      if (fixtureVersion !== 'pi 1.1.0\n') throw new Error(`Linux Pi fixture returned unexpected version output: ${JSON.stringify(fixtureVersion)}`);
      sessionFile = path.join(fixtureRoot, 'source.jsonl');
      const timestamp = testDate().toISOString();
      await fs.writeFile(sessionFile, [
        { type: 'session', version: 3, id: 'pi-source', cwd: mapper.toTargetPath(hostCwd), timestamp },
        { type: 'message', id: 'user-1', parentId: null, timestamp, message: { role: 'user', content: 'Question from WSL' } },
        { type: 'message', id: 'answer-1', parentId: 'user-1', timestamp, message: { role: 'assistant', content: [{ type: 'text', text: 'Reply stored in WSL.' }] } },
      ].map(record => JSON.stringify(record)).join('\n') + '\n');
      const installationKey = getInstallationKey();
      piConfig = {
        enabled: true, cliPathsByHost: { [installationKey]: command },
        installationMethodsByHost: { [installationKey]: 'wsl' }, wslDistroOverridesByHost: { [installationKey]: resolvedTarget.distroName },
        environmentVariables: `CLAUDIAN_TEST_PI_ROOT=${linuxRoot}\nPI_CODING_AGENT_SESSION_DIR=${fixtureRoot}\nPI_FIXTURE_VALUE=literal $HOME`,
      };
    });
    // The host fixture is test-scoped; native CLI lookup is the external answer the real Pi resolver supplies.
    beforeEach(async () => {
      const resolver = new PiCLIResolver();
      const fixture = await createProviderHostFixture({
        settings: { providerConfigs: { pi: structuredClone(piConfig) } },
        overrides: {
          workingDirectory: hostCwd,
          getResolvedProviderCliPath: async (_provider, context) => resolver.resolveFromSettings(fixture.settings, context),
        },
      });
      piHost = fixture.host.getRuntimeHost('pi');
    });
    afterAll(async () => {
      if (linuxRoot) await probe(buildTargetLaunchSpec({ target: resolvedTarget, hostCwd, env, command: 'rm', args: ['-rf', linuxRoot] }));
    });

    it('detects the Linux CLI and runs model and command probes through the same target', async () => {
      expect(await inspectPiInstallation(piHost)).toEqual({ path: command, version: '1.1.0', source: 'custom' });
      expect(await new PiModelDiscoveryService(piHost).discoverModels()).toMatchObject({ kind: 'completed', models: [{ encodedId: 'pi:test/fixture' }] });
      const metadata = new PiCommandMetadataProbe(piHost);
      try { expect(await metadata.load(hostCwd)).toEqual([]); } finally { await metadata.dispose(); }
    });

    it('delivers a >32K literal prompt, maps extensions/session paths and round-trips session tools over stdio', async () => {
      const promptText = '  Literal $HOME `uname` "quotes"\n' + '正文'.repeat(25_000) + '\n  ';
      const launch = buildPiLaunchSpec({
        command, cwd: hostCwd, executionTarget: resolvedTarget,
        env: { ...env, ...parseEnvironmentVariables(piHost.environmentText) }, envText: piHost.environmentText,
        settings: decodePiConfig(piHost.config, piHost.selection), systemPrompt: promptText,
        providerState: { sessionFile }, enableTreeBridge: true, enableSessionTools: true,
      });
      const port = { list: vi.fn().mockResolvedValue({ sessions: [] }), send: vi.fn(), read: vi.fn() };
      const kernel = new PiRPCSessionKernel(launch, {
        getSessionToolInvocation: () => ({ port, toolPolicy: { kind: 'provider-default' }, signal: new AbortController().signal }),
        onClose() {}, onEvent() {}, onExtensionChunk() {}, onExtensionRequest: () => true,
      }, null);
      let promptFile: string | undefined;
      let extensionFiles: string[];
      try {
        kernel.start();
        const details = await kernel.request<{ cwd: string; args: string[]; prompt: string; promptFile: string; sessionDir: string; customValue: string }>('fixture_launch');
        expect(details.prompt).toBe(promptText);
        expect(details.cwd).toBe(createExecutionPathMapper(resolvedTarget).toTargetPath(hostCwd));
        expect(details.sessionDir).toBe(linuxRoot);
        expect(details.customValue).toBe('literal $HOME');
        promptFile = piHostPath(details.promptFile, resolvedTarget);
        extensionFiles = details.args.flatMap((arg, index) => arg === '--extension' ? [piHostPath(details.args[index + 1], resolvedTarget)] : []);
        expect(extensionFiles).toHaveLength(2);
        expect(await kernel.request('get_state')).toMatchObject({ sessionId: 'pi-source', sessionFile: piTargetPath(sessionFile, resolvedTarget) });
        expect(await kernel.request('claudian_tree', { operation: 'inspect', sessionId: 'pi-source', sessionFile: piTargetPath(sessionFile, resolvedTarget) }))
          .toMatchObject({ cancelled: false, sessionId: 'pi-source', leafId: 'answer-1' });
        expect(await kernel.request('fixture_tool', { name: 'claudian_list_destinations', toolCallId: 'list', args: {} }))
          .toMatchObject({ isError: false, content: [{ text: '{"sessions":[]}' }] });
        expect(port.list).toHaveBeenCalledOnce();
      } finally { await kernel.shutdown(); }
      await expect(fs.stat(promptFile!)).rejects.toMatchObject({ code: 'ENOENT' });
      for (const extension of extensionFiles) await expect(fs.stat(extension)).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('discovers the default Linux home for an ID-only history read', async () => {
      const nativeHome = (await probe(buildTargetLaunchSpec({ target: resolvedTarget, hostCwd, env,
        command: '/bin/sh', args: ['-c', 'printf "%s" "$HOME"'],
      })))!;
      const hostRoot = piHostPath(`${nativeHome}/.pi/agent/sessions`, resolvedTarget);
      await fs.mkdir(hostRoot, { recursive: true });
      const directory = await fs.mkdtemp(path.join(hostRoot, 'claudian-wsl-test-'));
      const sessionId = path.basename(directory);
      try {
        await fs.writeFile(path.join(directory, `${sessionId}.jsonl`),
          (await fs.readFile(sessionFile, 'utf8')).replace('"id":"pi-source"', `"id":${JSON.stringify(sessionId)}`));
        const result = await new PiConversationHistoryService().hydrateConversationHistory({
          sessionId, providerState: { sessionId }, messages: [],
        }, hostCwd, {
          executionTarget: resolvedTarget,
          environment: { ...env, PI_CODING_AGENT_DIR: '', PI_CODING_AGENT_SESSION_DIR: '', PI_PACKAGE_DIR: '' },
          environmentText: 'PI_CODING_AGENT_DIR=\nPI_CODING_AGENT_SESSION_DIR=\nPI_PACKAGE_DIR=',
        });
        expect(result.messages).toMatchObject([{ content: 'Question from WSL' }, { content: 'Reply stored in WSL.' }]);
      } finally { await fs.rm(directory, { recursive: true, force: true }); }
    });

    it('reads the transcript through the plugin API and writes Linux fork header paths', async () => {
      const history = new PiConversationHistoryService();
      const context = { config: piHost.config, environmentText: piHost.environmentText, environment: { ...env, ...parseEnvironmentVariables(piHost.environmentText) }, hostPlatform: 'win32' as const };
      const conversation = { id: 'pi-chat', providerId: 'pi' as const, sessionId: 'pi-source', providerState: { sessionId: 'pi-source', sessionFile }, messages: [], title: 'WSL', createdAt: testDate().getTime(), lastActivityAt: testDate().getTime() };
      const host = await createChatFeatureHost({
        ensureConversationMetadataLoaded: async () => undefined,
        getConversationById: async () => ({ ...conversation, ...(await history.hydrateConversationHistory(conversation, hostCwd, context)) }),
        sessionRuntimes: createSessionRuntimePool(() => host),
      });
      const messaging = new SessionMessagingService({ getHost: () => host, getActiveConversationId: () => null, refreshModelControls() {} });
      expect(await createClaudianAPI(messaging).read('pi-chat')).toBe('Reply stored in WSL.');
      const fork = await createPiForkSessionFile(sessionFile, 'answer-1', { targetCwd: piTargetPath(hostCwd, resolvedTarget), parentSession: piTargetPath(sessionFile, resolvedTarget) });
      expect((await readPiSessionEntries(fork.sessionFile)).header).toMatchObject({ cwd: piTargetPath(hostCwd, resolvedTarget), parentSession: piTargetPath(sessionFile, resolvedTarget) });
      expect(fork.parentSession).toBe(sessionFile);
      expect(await fs.readFile(sessionFile, 'utf8')).not.toContain(fork.sessionId);
      await fs.rm(fork.sessionFile);
    });
  });

  it('detects the same real default distro synchronously and asynchronously', async () => {
    expect(resolvedTarget.distroName).toBeTruthy();
    expect(await resolveExecutionTargetAsync({ settings })).toEqual(resolvedTarget);
    expect(await probe(buildTargetLaunchSpec({ target: resolvedTarget, hostCwd, env, command: 'printenv', args: ['WSL_DISTRO_NAME'] })))
      .toBe(`${resolvedTarget.distroName}\n`);
  });

  it('maps Windows drives and both distro UNC namespaces to actual Linux files and cwd', async () => {
    const mapper = createExecutionPathMapper(resolvedTarget);
    await fs.writeFile(path.join(hostCwd, 'note.txt'), 'mapped file');
    expect(await probe(buildTargetLaunchSpec({ target: resolvedTarget, hostCwd, env, command: 'cat', args: ['./note.txt'] }))).toBe('mapped file');
    const nativePath = await probe(buildTargetLaunchSpec({ target: resolvedTarget, hostCwd, env, command: 'wslpath', args: ['-u', hostCwd] }));
    expect(mapper.toTargetPath(hostCwd)).toBe(nativePath?.trim());
    expect(mapper.toHostPath(nativePath!.trim())).toBe(hostCwd);
    for (const server of ['wsl$', 'wsl.localhost']) {
      const unc = `\\\\${server}\\${resolvedTarget.distroName}\\tmp`;
      const inferred = resolveExecutionTarget({ settings, hostVaultPath: unc });
      expect(inferred.distroName).toBe(resolvedTarget.distroName);
      expect(await probe(buildTargetLaunchSpec({ target: inferred, hostCwd: unc, env, command: 'pwd', args: [] }))).toBe('/tmp\n');
    }
  });

  it('preserves empty arguments, spaces, quotes, newlines, Unicode and shell metacharacters', async () => {
    const args = ['=sh', '~', '*', '$x', 'double\\\\slash', '', 'two words', '"double"', "'single'", 'a\\b\\', 'line1\nline2', '$HOME; echo injected', '`pwd`', '*.json', '中文 🎉'];
    const result = await probe(buildTargetLaunchSpec({ target: resolvedTarget, hostCwd, env, command: 'printf', args: ['%s\\0', ...args] }));
    expect(result?.split('\0').slice(0, -1)).toEqual(args);
  });

  it('forwards declared WSLENV values and translates host paths and lists without replacing Linux HOME/PATH', async () => {
    const baseline = await probe(buildTargetLaunchSpec({ target: resolvedTarget, hostCwd, env, command: 'sh', args: ['-c', 'printf "%s\\0%s\\0" "$HOME" "$PATH"'] }));
    const mapper = createExecutionPathMapper(resolvedTarget);
    const forwardEnv = {
      ...env, WSLENV: 'WSL_TEST_EXISTING:WSL_TEST_VALUE/w:WSL_TEST_PATH/up', WSL_TEST_EXISTING: 'existing',
      WSL_TEST_VALUE: 'quotes " \'\n$HOME', WSL_TEST_PATH: hostCwd,
      WSL_TEST_LIST: `${hostCwd};${path.join(hostCwd, 'second')}`,
      HOME: 'C:\\should-not-replace-linux-home',
    };
    const spec = buildTargetLaunchSpec({
      target: resolvedTarget, hostCwd, env: forwardEnv, command: 'sh',
      args: ['-c', 'printf "%s\\0" "$WSL_TEST_EXISTING" "$WSL_TEST_VALUE" "$WSL_TEST_PATH" "$WSL_TEST_LIST" "$HOME" "$PATH"'],
      forwardEnvironment: [{ key: 'WSL_TEST_VALUE' }, { key: 'WSL_TEST_PATH', hostPath: true }, { key: 'WSL_TEST_LIST', hostPath: true, pathList: true }],
    });
    expect((await probe(spec))?.split('\0').slice(0, -1)).toEqual([
      'existing', forwardEnv.WSL_TEST_VALUE, mapper.toTargetPath(hostCwd),
      `${mapper.toTargetPath(hostCwd)}:${mapper.toTargetPath(path.join(hostCwd, 'second'))}`,
      ...baseline!.split('\0').slice(0, -1),
    ]);
  });

  it('probes the native target environment and distinguishes unset from empty values', async () => {
    const nativeHome = await probe(buildTargetLaunchSpec({ target: resolvedTarget, hostCwd, env, command: '/bin/sh', args: ['-c', 'printf "%s" "$HOME"'] }));
    const literal = 'quotes " \' \n$HOME; `pwd`';
    expect(await probeTargetEnvironment({ target: resolvedTarget, hostCwd,
      env: { ...env, WSL_TEST_EMPTY: '', WSL_TEST_LITERAL: literal },
      variables: ['HOME', 'WSL_TEST_EMPTY', 'WSL_TEST_MISSING', 'WSL_TEST_LITERAL'],
      forwardEnvironment: [{ key: 'WSL_TEST_EMPTY' }, { key: 'WSL_TEST_LITERAL' }],
    })).toEqual({ HOME: nativeHome, WSL_TEST_EMPTY: '', WSL_TEST_MISSING: undefined, WSL_TEST_LITERAL: literal });
  });

  it('launches wsl.exe when explicitly forwarding a Linux-only PATH', async () => {
    const spec = buildTargetLaunchSpec({
      target: resolvedTarget, hostCwd, env: { ...env, PATH: '/usr/bin:/bin', WSLENV: '' },
      command: '/usr/bin/true', args: [], forwardEnvironment: [{ key: 'PATH' }],
    });
    expect(await probe(spec)).toBe('');
  });

  it('probes a Linux-only CLI with spaces and quotes in its path through the same launch wrapper', async () => {
    const root = (await probe(buildTargetLaunchSpec({ target: resolvedTarget, hostCwd, env, command: 'mktemp', args: ['-d'] })))!.trim();
    const command = `${root}/CLI with 'quotes'`;
    const launch = (cmd: string, args: string[]) => probe(buildTargetLaunchSpec({ target: resolvedTarget, hostCwd, env, command: cmd, args }));
    try {
      await launch('sh', ['-c', 'printf \'#!/bin/sh\nprintf "test-cli 1.2.3\\n"\n\' > "$1" && chmod +x "$1"', 'fixture', command]);
      expect(await probeTargetCLIInstallation({ target: resolvedTarget, hostCwd, env, command, configuredPath: command, args: ['--version'] }))
        .toEqual({ path: command, version: '1.2.3', source: 'custom' });
      const referenceEnv = { ...env, HOME: root };
      const forwardEnvironment = [{ key: 'HOME' }];
      // WSL init overwrites HOME before the launcher runs; verify restoration.
      expect(await probe(buildTargetLaunchSpec({ target: resolvedTarget, hostCwd, env: referenceEnv,
        command: '/bin/sh', args: ['-c', 'printf "%s" "$HOME"'], forwardEnvironment,
      }))).toBe(root);
      const reference = "~/CLI with 'quotes'";
      expect(await probe(buildTargetLaunchSpec({ target: resolvedTarget, hostCwd, env: referenceEnv, command: reference, args: ['--version'], forwardEnvironment })))
        .toBe('test-cli 1.2.3\n');
      expect(await probeTargetCLIInstallation({ target: resolvedTarget, hostCwd, env: referenceEnv, command: reference, configuredPath: reference, args: ['--version'], forwardEnvironment }))
        .toEqual({ path: command, version: '1.2.3', source: 'custom' });
      expect(await probeTargetCLIInstallation({ target: resolvedTarget, hostCwd, env, command: `${root}/missing`, configuredPath: '', args: ['--version'] }))
        .toEqual({ path: null, version: null, source: 'auto' });
    } finally { await launch('rm', ['-rf', root]); }
  });

  for (const shell of shells) it.skipIf(!installedShells.has(shell))(`preserves the real ${shell} environment, argv and protocol stdout`, async () => {
    const launch = (command: string, args: string[]) => probe(buildTargetLaunchSpec({ target: resolvedTarget, hostCwd, env, command, args }));
    const root = (await launch('mktemp', ['-d', '/tmp/claudian-shell-XXXXXX']))!.trim();
    try {
      const writeFixture = async (behavior: WSLShellBehavior = 'ordinary') => {
        const files = Object.entries(wslShellFixtureFiles(behavior)).flatMap(([relative, content]) => [`${root}/${relative}`, content]);
        expect(await launch('/bin/sh', ['-c', 'while [ "$#" -gt 0 ]; do mkdir -p "$(dirname "$1")" && printf "%s" "$2" > "$1" && chmod +x "$1"; shift 2; done', 'fixture', ...files])).not.toBeNull();
      };
      await writeFixture();
      const specFor = (command: string, args: string[], callerEnv: Record<string, string> = {}) => {
        const spec = buildTargetLaunchSpec({ target: resolvedTarget, hostCwd, env: { ...env, ...callerEnv }, command, args,
          forwardEnvironment: Object.keys(callerEnv).map(key => ({ key })),
        });
        // Choose isolated startup files without changing the distro account.
        spec.args.splice(spec.args.indexOf('--exec') + 1, 0, '/usr/bin/env',
          `SHELL=/bin/${shell}`, `HOME=${root}`, `ZDOTDIR=${root}`, `XDG_CONFIG_HOME=${root}/config`,
          `CLAUDIAN_WSL_TEST_HOME=${root}`, `CLAUDIAN_WSL_TEST_NOISE=${'x'.repeat(20_000)}`);
        return spec;
      };
      const run = (args: string[]) => probe(specFor('test-cli', args));
      expect((await run(WSL_LITERAL_ARGS))?.split('\0').slice(0, -1)).toEqual(WSL_LITERAL_ARGS);
      const first = (await run(['--exports']))?.split('\0');
      const second = (await run(['--exports']))?.split('\0');
      expect(first?.slice(0, 2)).toEqual(['linux-shell-key', `${root}/codex-home`]);
      expect(second?.[2]).not.toBe(first?.[2]);
      expect(await run(['--version'])).toBe('test-cli 1.2.3\n');
      expect(await run(['--cwd'])).toBe(createExecutionPathMapper(resolvedTarget).toTargetPath(hostCwd));
      const excludedPathSpec = specFor('test-cli', ['--version']);
      excludedPathSpec.env = { ...excludedPathSpec.env, PATH: '/usr/bin:/bin', WSLENV: 'PATH/w' };
      expect(await probe(excludedPathSpec)).toBe('test-cli 1.2.3\n');
      const callerEnv = { OPENAI_API_KEY: 'caller-key', CODEX_HOME: '/caller-home' };
      expect((await probe(specFor('test-cli', ['--exports'], callerEnv)))?.split('\0').slice(0, 2))
        .toEqual(['caller-key', '/caller-home']);
      for (const behavior of ['read', 'replace', 'background', 'fail'] as const) {
        await writeFixture(behavior);
        const spec = specFor('/bin/sh', ['-c', 'IFS= read -r line; sleep 0.3; printf "%s" "$line"']);
        // A plain spawn proves the descriptor works for every provider spawner.
        const child = spawn(spec.command, spec.args, { cwd: spec.spawnCwd, env: spec.env, windowsHide: true, windowsVerbatimArguments: spec.windowsVerbatimArguments });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', chunk => { stdout += String(chunk); });
        child.stderr.on('data', chunk => { stderr += String(chunk); });
        const closed = new Promise<number | null>(resolve => child.on('close', resolve));
        child.stdin.end('{"method":"initialize"}\n');
        expect(await closed).toBe(0);
        expect(stdout).toBe('{"method":"initialize"}');
        expect(stderr.match(/Unable to capture WSL shell environment/g) ?? [], `${shell} ${behavior}: ${stderr}`)
          .toHaveLength(behavior === 'replace' || behavior === 'fail' ? 1 : 0);
      }
      await writeFixture('temp-file');
      expect(await probe(specFor('/bin/sh', ['-c', 'file=$(cat "$HOME/capture-path"); test ! -e "$file" && cat "$HOME/capture-mode"'])))
        .toMatch(/^-rw-------/);

    } finally { await launch('rm', ['-rf', root]); }
  });

});
