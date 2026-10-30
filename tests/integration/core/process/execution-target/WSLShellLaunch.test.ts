import { execFileSync, spawn as spawnNative } from 'node:child_process';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { readWSLExec } from '@test/helpers/WSLLaunch';
import { WSL_LITERAL_ARGS, type WSLShellBehavior, wslShellFixtureFiles } from '@test/helpers/WSLShellFixture';

vi.mock('cross-spawn', () => ({ default: vi.fn() }));

import spawn from 'cross-spawn';

import { buildTargetLaunchSpec } from '@/core/process/execution-target/TargetLaunchSpec';
import { runProcessProbe } from '@/core/process/ProcessProbe';
import { probeTargetCLIInstallation } from '@/core/providers/cli/TargetCLIInstallationProbe';

const shells = ['bash', 'zsh', 'csh', 'tcsh', 'fish'].map(name => {
  let executable = '';
  if (process.platform !== 'win32') {
    try { executable = execFileSync('/bin/sh', ['-c', 'command -v "$1"', 'fixture', name], { encoding: 'utf8' }).trim(); } catch { /* Optional shell is not installed. */ }
  }
  return { name, executable };
});

for (const { name, executable } of shells) {
  describe.skipIf(!executable)(`real ${name} WSL launch contract`, () => {
    let root: string;
    let noise = '';
    let stderr = '';
    const target = { method: 'wsl', distroName: 'Ubuntu', platformFamily: 'unix', platformOs: 'linux' } as const;
    async function writeFixture(behavior: WSLShellBehavior = 'ordinary') {
      for (const [relative, content] of Object.entries(wslShellFixtureFiles(behavior))) {
        const file = path.join(root, relative);
        await fs.mkdir(path.dirname(file), { recursive: true });
        await fs.writeFile(file, content, { mode: 0o755 });
      }
    }
    beforeEach(async () => {
      root = await fs.mkdtemp(path.join(tmpdir(), 'claudian-shell-'));
      await writeFixture();
      noise = '';
      stderr = '';
      vi.mocked(spawn).mockImplementation((_command, args, spawnOptions) => {
        const decoded = readWSLExec({ args: [...args!] });
        const child = spawnNative(decoded.command, decoded.args, { cwd: root, env: {
          ...spawnOptions?.env, SHELL: executable, HOME: root, ZDOTDIR: root, XDG_CONFIG_HOME: `${root}/config`,
          CLAUDIAN_WSL_TEST_HOME: root, CLAUDIAN_WSL_TEST_NOISE: noise,
        } });
        child.stderr.on('data', chunk => { stderr = (stderr + String(chunk)).slice(-1000); });
        return child as never;
      });
    });
    afterEach(async () => { vi.mocked(spawn).mockReset(); await fs.rm(root, { recursive: true, force: true }); });

    const options = (command: string, args: string[]) => ({ target, hostCwd: 'C:\\vault', command, args, env: {} });
    async function run(command: string, args: string[]) {
      const spec = buildTargetLaunchSpec(options(command, args));
      const output = await runProcessProbe({ ...spec, cwd: spec.spawnCwd });
      if (output === null) throw new Error(stderr);
      return output;
    }


    it('keeps explicitly forwarded credentials and home authoritative over startup exports', async () => {
      const spec = buildTargetLaunchSpec({ ...options(`${root}/bin/test-cli`, ['--exports']),
        env: { OPENAI_API_KEY: 'caller-key', CODEX_HOME: '/caller-home' },
        forwardEnvironment: [{ key: 'OPENAI_API_KEY' }, { key: 'CODEX_HOME' }],
      });
      expect((await runProcessProbe({ ...spec, cwd: root }))?.split('\0').slice(0, 2))
        .toEqual(['caller-key', '/caller-home']);
    });

    it('lets startup PATH take effect when inherited WSLENV excludes Windows-to-Linux forwarding', async () => {
      const spec = buildTargetLaunchSpec({ ...options('test-cli', ['--version']),
        env: { PATH: '/usr/bin:/bin', WSLENV: 'PATH/w' },
      });
      expect(await runProcessProbe({ ...spec, cwd: root })).toBe('test-cli 1.2.3\n');
    });

    it.each(['read', 'replace', 'background', 'fail'] as const)('isolates %s startup from protocol streams and falls back when capture fails', async behavior => {
      await writeFixture(behavior);
      const spec = buildTargetLaunchSpec(options('/bin/sh', ['-c', 'IFS= read -r line; sleep 0.3; printf "%s" "$line"']));
      const child = spawn(spec.command, spec.args, { cwd: root, env: spec.env, windowsVerbatimArguments: spec.windowsVerbatimArguments });
      let output = '';
      child.stdout!.on('data', chunk => { output += String(chunk); });
      const closed = new Promise<number | null>(resolve => child.on('close', resolve));
      child.stdin!.end('{"method":"initialize"}\n');
      expect(await closed).toBe(0);
      expect(output).toBe('{"method":"initialize"}');
      expect(stderr.match(/Unable to capture WSL shell environment/g) ?? [])
          .toHaveLength(behavior === 'replace' || behavior === 'fail' ? 1 : 0);
    });

    it('creates a private environment file and removes it before the CLI starts', async () => {
      await writeFixture('temp-file');
      expect(await run('/bin/sh', ['-c', 'true'])).toBe('');
      const capturePath = await fs.readFile(path.join(root, 'capture-path'), 'utf8');
      expect(capturePath).not.toBe('');
      expect(await fs.readFile(path.join(root, 'capture-mode'), 'utf8')).toMatch(/^-rw-------/);
      await expect(fs.stat(capturePath)).rejects.toThrow(/ENOENT/);
    });

    it('inherits shell credentials and home exports and keeps rc noise out of stdout', async () => {
      const output = await run(`${root}/bin/test-cli`, ['--exports']);
      expect(output?.split('\0').slice(0, 2)).toEqual(['linux-shell-key', `${root}/codex-home`]);
    });

    it('preserves hostile literal argv and finds the CLI and node through startup PATH', async () => {
      expect((await run('test-cli', WSL_LITERAL_ARGS))?.split('\0').slice(0, -1)).toEqual(WSL_LITERAL_ARGS);
      expect(await probeTargetCLIInstallation({ ...options('test-cli', ['--version']), configuredPath: '' }))
        .toEqual({ path: `${root}/bin/test-cli`, version: '1.2.3', source: 'auto' });
      expect(await run('~/bin/test-cli', ['--version'])).toBe('test-cli 1.2.3\n');
      expect(await run('./bin/test-cli', ['--cwd'])).toBe(await fs.realpath(root));
    });

    it('does not import volatile exports into launch inputs and tolerates large startup noise', async () => {
      noise = 'x'.repeat(20_000);
      const first = buildTargetLaunchSpec(options('test-cli', ['--exports']));
      const second = buildTargetLaunchSpec(options('test-cli', ['--exports']));
      expect({ ...second, pathMapper: undefined }).toEqual({ ...first, pathMapper: undefined });
      const a = await runProcessProbe({ ...first, cwd: first.spawnCwd });
      const b = await runProcessProbe({ ...second, cwd: second.spawnCwd });
      expect(a?.split('\0').slice(0, 2)).toEqual(['linux-shell-key', `${root}/codex-home`]);
      expect(b?.split('\0')[2]).not.toBe(a?.split('\0')[2]);
    });
  });
}

let hasProcessGroups = false;
if (process.platform === 'linux') {
  try { hasProcessGroups = Boolean(execFileSync('/bin/sh', ['-c', 'command -v setsid'], { encoding: 'utf8' }).trim()); } catch { /* PID-only fallback is covered by the other lifecycle cases. */ }
}

for (const name of ['bash', 'dash', 'busybox']) {
  let executable = '';
  if (process.platform !== 'win32') {
    try { executable = execFileSync('/bin/sh', ['-c', 'command -v "$1"', 'fixture', name], { encoding: 'utf8' }).trim(); } catch { /* Optional outer interpreter. */ }
  }
  describe.skipIf(!executable)(`${name}-as-sh capture lifecycle`, () => {
    let root: string;
    let stderr: string;
    const options = () => buildTargetLaunchSpec({
      target: { method: 'wsl', distroName: 'Ubuntu', platformFamily: 'unix', platformOs: 'linux' },
      hostCwd: 'C:\\vault', env: {}, command: '/bin/sh', args: ['-c', 'printf "CLI_OK:%s" "$OPENAI_API_KEY"; umask'],
    });
    const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
    async function captureFile() {
      let file = '';
      await vi.waitFor(async () => { file = await fs.readFile(path.join(root, 'capture-path'), 'utf8'); expect(file).not.toBe(''); });
      return file;
    }
    async function startup(body: string) {
      await fs.writeFile(path.join(root, '.bashrc'), `printf '%s' "$CLAUDIAN_WSL_ENV_FILE" > "$HOME/capture-path"\nprintf '%s' "$$" > "$HOME/capture-pid"\n${body}\n`);
    }
    beforeEach(async () => {
      root = await fs.mkdtemp(path.join(tmpdir(), 'claudian-capture-'));
      stderr = '';
      await fs.writeFile(path.join(root, '.bash_profile'), '. "$HOME/.bashrc"\n');
      vi.mocked(spawn).mockImplementation((_command, args, spawnOptions) => {
        const decoded = readWSLExec({ args: [...args!] });
        const child = spawnNative(executable, decoded.args, { argv0: 'sh', cwd: root, env: {
          ...spawnOptions?.env, PATH: '/usr/bin:/bin', SHELL: '/bin/bash', HOME: root, OPENAI_API_KEY: 'base-key',
        } });
        child.stderr.on('data', chunk => { stderr += String(chunk); });
        return child as never;
      });
    });
    afterEach(async () => {
      vi.mocked(spawn).mockReset();
      const pid = Number(await fs.readFile(path.join(root, 'capture-pid'), 'utf8').catch(() => '0'));
      try { if (pid) process.kill(pid, 'SIGKILL'); } catch { /* Capture already exited. */ }
      const file = await fs.readFile(path.join(root, 'capture-path'), 'utf8').catch(() => '');
      if (file) await fs.rm(file, { force: true });
      await fs.rm(root, { recursive: true, force: true });
    });

    it.each(['SHELLOPTS', 'UID', 'EUID'])('survives importing exported readonly %s', async key => {
      await startup(`export ${key}\nexport OPENAI_API_KEY=shell-key`);
      const spec = options();
      const output = await runProcessProbe({ ...spec, cwd: root });
      expect(output).toBe(`CLI_OK:${name === 'bash' ? 'base' : 'shell'}-key${process.umask().toString(8).padStart(4, '0')}\n`);
      expect(stderr.match(/Unable to capture WSL shell environment/g) ?? []).toHaveLength(name === 'bash' ? 1 : 0);
      await expect(fs.stat(await captureFile())).rejects.toThrow(/ENOENT/);
    });

    it('reaps capture on a production probe timeout before removing its private file', async () => {
      await startup('export OPENAI_API_KEY=fixture-key-only\nsleep 0.8');
      const spec = options();
      expect(await runProcessProbe({ ...spec, cwd: root }, 300)).toBeNull();
      const file = await captureFile();
      await delay(900);
      const pid = Number(await fs.readFile(path.join(root, 'capture-pid'), 'utf8'));
      expect(() => process.kill(pid, 0)).toThrow();
      await expect(fs.stat(file)).rejects.toThrow(/ENOENT/);
    });

    it.each(['SIGHUP', 'SIGINT', 'SIGTERM'] as const)('cleans up capture on %s without leaving a late writer', async signal => {
      await startup('sleep 0.5');
      const spec = options();
      const child = spawn(spec.command, spec.args, { cwd: root, env: spec.env });
      child.stdin!.end();
      child.stdout!.resume();
      const closed = new Promise(resolve => child.on('close', resolve));
      const file = await captureFile();
      child.kill(signal);
      await closed;
      await delay(600);
      const pid = Number(await fs.readFile(path.join(root, 'capture-pid'), 'utf8'));
      expect(() => process.kill(pid, 0)).toThrow();
      await expect(fs.stat(file)).rejects.toThrow(/ENOENT/);
    });

    it.skipIf(!hasProcessGroups).each(['deadline', 'cancellation'] as const)('stops a TERM-resistant startup descendant on %s', async reason => {
      await startup(`/bin/sh -c 'printf "%s" "$$" > "$HOME/blocking-pid"; trap "" TERM; exec tail -f /dev/null'`);
      const spec = options();
      try {
        const result = await runProcessProbe({ ...spec, cwd: root }, reason === 'deadline' ? 12_000 : 300);
        expect(result).toBe(reason === 'deadline' ? `CLI_OK:base-key${process.umask().toString(8).padStart(4, '0')}\n` : null);
        const pid = Number(await fs.readFile(path.join(root, 'blocking-pid'), 'utf8'));
        // Linux PID 1 may retain a dead orphan briefly; a zombie is no live job.
        const status = await fs.readFile(`/proc/${pid}/stat`, 'utf8').catch(() => '');
        expect(status === '' || /\) Z /.test(status)).toBe(true);
        await expect(fs.stat(await captureFile())).rejects.toThrow(/ENOENT/);
      } finally {
        const pid = Number(await fs.readFile(path.join(root, 'blocking-pid'), 'utf8').catch(() => '0'));
        try { if (pid) process.kill(pid, 'SIGKILL'); } catch { /* Already stopped. */ }
      }
    }, 15_000);

    it('bounds a hanging startup and falls back with the original CLI umask', async () => {
      await startup('export OPENAI_API_KEY=shell-key\nsleep 30');
      const spec = options();
      expect(await runProcessProbe({ ...spec, cwd: root }, 12_000))
        .toBe(`CLI_OK:base-key${process.umask().toString(8).padStart(4, '0')}\n`);
      expect(stderr.match(/Unable to capture WSL shell environment/g) ?? []).toHaveLength(1);
      const pid = Number(await fs.readFile(path.join(root, 'capture-pid'), 'utf8'));
      expect(() => process.kill(pid, 0)).toThrow();
      await expect(fs.stat(await captureFile())).rejects.toThrow(/ENOENT/);
    }, 15_000);
  });
}
