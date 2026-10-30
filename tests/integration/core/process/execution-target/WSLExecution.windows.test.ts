import { execFileSync, spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { WSL_LITERAL_ARGS, type WSLShellBehavior, wslShellFixtureFiles } from '@test/helpers/WSLShellFixture';

import { resolveExecutionTarget, resolveExecutionTargetAsync } from '@/core/process/execution-target/ExecutionTargetResolver';
import { buildTargetLaunchSpec } from '@/core/process/execution-target/TargetLaunchSpec';
import type { ExecutionTarget, TargetLaunchSpec } from '@/core/process/execution-target/types';
import { createExecutionPathMapper } from '@/core/process/execution-target/WSLPathMapper';
import { runProcessProbe } from '@/core/process/ProcessProbe';
import { probeTargetCLIInstallation } from '@/core/providers/cli/TargetCLIInstallationProbe';

const settings = { installationMethod: 'wsl' as const, wslDistroOverride: '' };
const target = process.platform === 'win32' ? resolveExecutionTarget({ settings }) : null;
let available = false;
if (target?.distroName) {
  try {
    execFileSync('wsl.exe', ['--distribution', target.distroName, '--exec', '/bin/true'], { timeout: 20_000, windowsHide: true });
    available = true;
  } catch { /* Machines without a usable WSL distro skip the native suite. */ }
}
if (process.env.CLAUDIAN_REQUIRE_WSL === '1' && !available) {
  throw new Error('The WSL CI job requires a running distro; native tests must not skip.');
}

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
        expect(stderr.match(/Unable to capture WSL shell environment/g) ?? [])
          .toHaveLength(behavior === 'replace' || behavior === 'fail' ? 1 : 0);
      }
      await writeFixture('temp-file');
      expect(await probe(specFor('/bin/sh', ['-c', 'file=$(cat "$HOME/capture-path"); test ! -e "$file" && cat "$HOME/capture-mode"'])))
        .toMatch(/^-rw-------/);

    } finally { await launch('rm', ['-rf', root]); }
  });

});
