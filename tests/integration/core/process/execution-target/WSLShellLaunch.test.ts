// @test-ci {"native":true}
import { spawn as spawnNative } from 'node:child_process';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { readWSLExec } from '@test/helpers/WSLLaunch';
import { localWSLExecutable, WSL_LITERAL_ARGS, type WSLShellBehavior, wslShellFixtureFiles } from '@test/helpers/WSLShellFixture';

vi.mock('cross-spawn', () => ({ default: vi.fn() }));

import spawn from 'cross-spawn';

import { probeTargetEnvironment } from '@/core/process/execution-target/TargetEnvironmentProbe';
import { buildTargetLaunchSpec } from '@/core/process/execution-target/TargetLaunchSpec';
import { runProcessProbe } from '@/core/process/ProcessProbe';
import { probeTargetCLIInstallation } from '@/core/providers/cli/TargetCLIInstallationProbe';

const shells = ['bash', 'zsh', 'csh', 'tcsh', 'fish'].map(name => ({ name, executable: localWSLExecutable(name) }));

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
        return child;
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

    it('reads target environment after startup with unset, empty and literal values preserved', async () => {
      const literal = 'quotes " \' \n$HOME; `pwd`';
      const env = { WSL_TEST_EMPTY: '', WSL_TEST_LITERAL: literal, OPENAI_API_KEY: 'caller-key' };
      const result = await probeTargetEnvironment({
        target, hostCwd: 'C:\\vault', env,
        variables: ['HOME', 'CODEX_HOME', 'OPENAI_API_KEY', 'WSL_TEST_EMPTY', 'WSL_TEST_MISSING', 'WSL_TEST_LITERAL', 'WSL_TEST_MISSING'],
        forwardEnvironment: Object.keys(env).map(key => ({ key })),
      });
      expect(result).toEqual({ HOME: root, CODEX_HOME: `${root}/codex-home`, OPENAI_API_KEY: 'caller-key',
        WSL_TEST_EMPTY: '', WSL_TEST_MISSING: undefined, WSL_TEST_LITERAL: literal });
    });

    it('preserves configured HOME when the platform supplies the account home', async () => {
      const configuredHome = `${root}/configured home`;
      await fs.mkdir(configuredHome);
      await fs.writeFile(`${configuredHome}/CLI with 'quotes'`, '#!/bin/sh\nprintf "test-cli 1.2.3\\n"\n', { mode: 0o755 });
      const spec = buildTargetLaunchSpec({ ...options("~/CLI with 'quotes'", ['--version']),
        env: { HOME: configuredHome }, forwardEnvironment: [{ key: 'HOME' }],
      });
      // The boundary fixture supplies the account HOME, as WSL init does.
      expect(await runProcessProbe({ ...spec, cwd: root })).toBe('test-cli 1.2.3\n');
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
