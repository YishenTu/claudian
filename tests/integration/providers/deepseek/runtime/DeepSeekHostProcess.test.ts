import { realpathSync } from 'node:fs';
import { access, chmod, copyFile, link, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { Writable } from 'node:stream';
import { pathToFileURL } from 'node:url';

import { NativePeer } from '@test/helpers/deepseek/NativePeer';

import { DeepSeekHostProcess } from '@/providers/deepseek/runtime/DeepSeekHostProcess';

const FAKE_DSH = resolve(__dirname, '../../../../fixtures/providers/deepseek/runtime/FakeDeepSeekCLI.mjs');

interface Invocation { pid: number; cwd: string; args: string[] }

const WINDOWS = process.platform === 'win32';

describe('native Host process', () => {
  let root: string;
  let home: string;
  let log: string;
  let peer: NativePeer;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'deepseek host process '));
    home = join(root, 'dsh home');
    log = join(root, 'invocations.log');
    await mkdir(join(home, 'profiles', 'web'), { recursive: true });
    await writeFile(join(home, 'profiles', 'web', 'package.json'), '{}');
    peer = new NativePeer();
    peer.onCall = method => method === 'session/list' ? { items: [] } : `${method} answered`;
    await peer.open();
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await peer.close();
    await rm(root, { recursive: true, force: true });
  });

  const start = (mode: string, extra: NodeJS.ProcessEnv = {}, signal = new AbortController().signal): Promise<DeepSeekHostProcess> => DeepSeekHostProcess.start({
    cliPath: FAKE_DSH, cwd: root, presetPlugins: [{ id: 'tool-todo', name: '@deepseek-ai/dsh-tool-todo' }],
    environment: { ...process.env, DSH_HOME: home, FAKE_DSH_LOG: log, FAKE_DSH_MODE: mode, FAKE_DSH_URL: peer.url, ...extra },
  }, signal);

  const invocations = async (): Promise<Invocation[]> => {
    const text = await readFile(log, 'utf8').catch(() => '');
    return text.split('\n').filter(Boolean).map(line => JSON.parse(line));
  };

  const launched = async (): Promise<Invocation> => {
    for (const deadline = Date.now() + 5000; Date.now() < deadline; await new Promise(resolve => setTimeout(resolve, 10))) {
      const [host] = await invocations();
      if (host) return host;
    }
    throw new Error('Fake dsh never launched its Host.');
  };

  const artifactRoot = (invocation: Invocation): string => dirname(invocation.args[invocation.args.indexOf('--patch') + 1]);

  const expectGone = async (invocation: Invocation): Promise<void> => {
    expect(() => process.kill(invocation.pid, 0)).toThrow();
    await expect(access(artifactRoot(invocation))).rejects.toThrow();
  };

  // These packages are the native boundary; the production carrier, launch overlay, process and client stay real.
  const desktop = async (mode = 'serve'): Promise<() => Promise<DeepSeekHostProcess>> => {
    await rm(join(home, 'profiles', 'web'), { recursive: true });
    const profile = join(home, 'profiles', 'desktop');
    await mkdir(profile, { recursive: true });
    await writeFile(join(profile, 'package.json'), '{"fixture":"desktop configuration"}');
    // The renamed per-user Windows install directory, or a renamed macOS bundle.
    const install = join(root, WINDOWS ? '深度 求索' : '深度 求索.app');
    const resources = WINDOWS ? join(install, 'resources') : join(install, 'Contents', 'Resources');
    const cli = join(resources, 'runtime', 'cli', 'bin', WINDOWS ? 'dsh.cmd' : 'dsh');
    const electron = WINDOWS ? join(install, 'DeepSeek Harness.exe') : join(install, 'Contents', 'MacOS', 'DeepSeek Harness');
    const packages = join(resources, 'app.asar', 'dsh', 'node_modules', '@deepseek-ai');
    await Promise.all([mkdir(dirname(cli), { recursive: true }), mkdir(dirname(electron), { recursive: true }),
      mkdir(join(packages, 'dsh-app-boot'), { recursive: true }), mkdir(join(packages, 'dsh'), { recursive: true })]);
    // The bundled command only forwards to the Electron executable; Claudian runs that executable itself, never the wrapper.
    await writeFile(cli, WINDOWS ? '@exit /b 9\r\n' : '#!/bin/sh\nexit 9\n');
    // Node stands in for Electron: it accepts --expose-internals and runs the given script, as ELECTRON_RUN_AS_NODE does.
    if (WINDOWS) await link(process.execPath, electron).catch(() => copyFile(process.execPath, electron));
    else await writeFile(electron, `#!/bin/sh\nexec '${process.execPath}' "$@"\n`);
    if (!WINDOWS) await Promise.all([chmod(cli, 0o700), chmod(electron, 0o700)]);
    await writeFile(join(packages, 'dsh-app-boot/package.json'), '{"type":"module","exports":"./index.js"}');
    await writeFile(join(packages, 'dsh-app-boot/index.js'), `
      import { readFileSync } from 'node:fs';
      export const loadLayeredEnv = () => ({ home: process.env.DSH_HOME });
      export const loadProfileDirectory = (name, directory) => ({ directory, manifest: JSON.parse(readFileSync(directory + '/package.json', 'utf8')) });
    `);
    await writeFile(join(packages, 'dsh/package.json'), '{"type":"module","exports":{"./profile-boot":"./boot.js"}}');
    await writeFile(join(packages, 'dsh/boot.js'), `
      import { writeFileSync } from 'node:fs';
      import { pathToFileURL } from 'node:url';
      export async function runProfile(options) {
        writeFileSync(process.env.FAKE_DESKTOP_LOG, JSON.stringify({ ...options, electronMode: process.env.ELECTRON_RUN_AS_NODE }));
        process.argv = [process.argv[0], 'dsh', '--profile', options.profile, '--patch', options.patchFiles[0], ...options.args];
        await import(pathToFileURL(${JSON.stringify(FAKE_DSH)}));
      }
    `);
    return () => DeepSeekHostProcess.start({ cliPath: cli, cwd: root, environment: {
      ...process.env, DSH_HOME: home, FAKE_DSH_LOG: log, FAKE_DSH_MODE: mode, FAKE_DSH_URL: peer.url,
      FAKE_DESKTOP_LOG: join(root, 'desktop.json'),
    } }, new AbortController().signal);
  };

  it('launches the installed Desktop profile through its bundled runtime and cleans up its owned Host', async () => {
    const launch = await desktop();
    const hostProcess = await launch();
    const invocation = await launched();
    try {
      expect(await hostProcess.client.call('session/modelCatalog')).toBe('session/modelCatalog answered');
      const boot = JSON.parse(await readFile(join(root, 'desktop.json'), 'utf8'));
      expect(boot).toMatchObject({
        profile: 'desktop', electronMode: '1', environment: { home },
        resolvedProfile: { profile: { directory: join(home, 'profiles/desktop'), manifest: { fixture: 'desktop configuration' } } },
        patchFiles: [expect.any(String)], args: ['--no-open', '--port', '0'],
      });
      expect(boot.resolvedProfile.installAnchor).toContain(join(WINDOWS ? 'resources' : 'Contents/Resources', 'app.asar/dsh/node_modules/@deepseek-ai/dsh/package.json'));
      // Only the Desktop runner ran: no version probe, and never the bundled command.
      expect(await invocations()).toEqual([invocation]);
      expect(await readFile(join(home, 'profiles/desktop/package.json'), 'utf8')).toBe('{"fixture":"desktop configuration"}');
      await expect(access(join(home, 'profiles/web'))).rejects.toThrow();
    } finally { await hostProcess.dispose(); }
    await expectGone(invocation);
  });

  it('directs a missing Desktop profile to Desktop first-run and never launches Web', async () => {
    const launch = await desktop();
    await rm(join(home, 'profiles/desktop'), { recursive: true });
    await expect(launch()).rejects.toThrow(/Desktop.*[Oo]pen.*Desktop/);
    expect(await invocations()).toEqual([]);
  });

  it('removes Desktop launch artifacts and the process after native profile boot fails', async () => {
    const launch = await desktop('exit');
    await expect(launch()).rejects.toThrow(/exited before becoming ready/);
    await expectGone(await launched());
  });

  it.each([
    ['after the origin', (url: string) => new URL(url).origin.length],
    ['inside the login token', (url: string) => url.length - 3],
  ])('connects to the launch URL split %s and removes the process and its launch files on dispose', async (_split, offset) => {
    const hostProcess = await start('serve', { FAKE_DSH_SPLIT: String(offset(peer.url)) });
    const exited = jest.fn();
    hostProcess.onExit(exited);
    const invocation = await launched();
    try {
      // Windows may report either the 8.3 or the long temp path; the native resolver canonicalizes both sides.
      expect(realpathSync.native(invocation.cwd)).toBe(realpathSync.native(root));
      expect(invocation.args).toEqual(['--profile', 'web', '--patch', expect.any(String), '--no-open', '--port', '0']);
      expect(await hostProcess.client.call('session/modelCatalog')).toBe('session/modelCatalog answered');
      await hostProcess.writePrompt('claudian', 'Live prompt');
      expect(await readFile(join(artifactRoot(invocation), 'prompts', 'claudian.txt'), 'utf8')).toBe('Live prompt');
      await hostProcess.writeCodeMode(true);
      expect(await readFile(join(artifactRoot(invocation), 'code-mode'), 'utf8')).toBe('both');
      const patch = JSON.parse(await readFile(invocation.args[invocation.args.indexOf('--patch') + 1], 'utf8'));
      const chat = patch.find((entry: { insert?: unknown }) => entry.insert).insert.find((entry: any) => entry.config?.id === 'claudian');
      expect(chat.config.plugins.at(-1)).toEqual({ id: 'tool-todo', name: '@deepseek-ai/dsh-tool-todo' });
    } finally { await hostProcess.dispose(); }
    await expectGone(invocation);
    expect(exited).not.toHaveBeenCalled();
  });

  it('reports an exit once its owner\'s end of stdin closes, and stays silent for exits caused by disposal', async () => {
    const hostProcess = await start('serve');
    const invocation = await launched();
    try {
      const exited = new Promise<void>(resolve => hostProcess.onExit(resolve));
      // Claudian's end of the pipe closing is what the bundled lifecycle plugin tethers the native Host to.
      (hostProcess as unknown as { process: { stdin: Writable } }).process.stdin.end();
      await exited;
      expect(() => process.kill(invocation.pid, 0)).toThrow();
    } finally { await hostProcess.dispose(); }
    await expectGone(invocation);

    const disposed = await start('serve');
    const late = jest.fn();
    const disposal = disposed.dispose();
    disposed.onExit(late);
    await disposal;
    expect(late).not.toHaveBeenCalled();
  });

  it('refuses a missing Web profile before running the CLI', async () => {
    await rm(join(home, 'profiles'), { recursive: true });
    await expect(start('serve')).rejects.toThrow(/Web profile is unavailable/);
    expect(await invocations()).toEqual([]);
  });

  it('finds the profile under a relative DSH_HOME the way the Host does, from the vault', async () => {
    const hostProcess = await start('serve', { DSH_HOME: 'dsh home' });
    await hostProcess.dispose();
    expect(await invocations()).toHaveLength(1);
  });

  it('launches the installed native version without probing or gating it', async () => {
    const hostProcess = await start('serve');
    await hostProcess.dispose();
    expect((await invocations()).map(entry => entry.args[0])).toEqual(['--profile']);
  });

  // Node refuses to spawn a .cmd without a shell, and a shell would reparse launch arguments.
  (WINDOWS ? describe : describe.skip)('with a Windows npm install', () => it('probes and launches dsh.cmd through Node and its owning package entry', async () => {
    const prefix = join(root, 'npm prefix');
    const dsh = join(prefix, 'node_modules', '@deepseek-ai', 'dsh');
    await mkdir(join(dsh, 'lib'), { recursive: true });
    await writeFile(join(dsh, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', bin: { dsh: 'lib/bin.js' } }));
    await writeFile(join(dsh, 'lib', 'bin.js'), `import(${JSON.stringify(pathToFileURL(FAKE_DSH).href)});\n`);
    await writeFile(join(prefix, 'dsh.cmd'), [
      '@ECHO off', 'GOTO start', ':find_dp0', 'SET dp0=%~dp0', 'EXIT /b', ':start', 'SETLOCAL', 'CALL :find_dp0',
      'IF EXIST "%dp0%\\node.exe" (', '  SET "_prog=%dp0%\\node.exe"', ') ELSE (', '  SET "_prog=node"', ')',
      'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js" %*', '',
    ].join('\r\n'));
    const hostProcess = await DeepSeekHostProcess.start({ cliPath: join(prefix, 'dsh.cmd'), cwd: root, environment: {
      ...process.env, DSH_HOME: home, FAKE_DSH_LOG: log, FAKE_DSH_MODE: 'serve', FAKE_DSH_URL: peer.url,
    } }, new AbortController().signal);
    const invocation = await launched();
    try {
      expect(await invocations()).toEqual([invocation]);
      expect(invocation.args).toEqual(['--profile', 'web', '--patch', expect.any(String), '--no-open', '--port', '0']);
      expect(await hostProcess.client.call('session/modelCatalog')).toBe('session/modelCatalog answered');
    } finally { await hostProcess.dispose(); }
    await expectGone(invocation);
  }));

  it('fails when the Host exits before printing its URL and removes its launch files', async () => {
    await expect(start('exit')).rejects.toThrow(/exited before becoming ready/);
    await expectGone(await launched());
  });

  it('stops a Host that never becomes ready when startup is cancelled or times out', async () => {
    const cancel = new AbortController();
    const cancelled = start('hang', {}, cancel.signal);
    const first = await launched();
    cancel.abort();
    await expect(cancelled).rejects.toThrow('DeepSeek startup cancelled.');
    await expectGone(first);

    await rm(log);
    const deadline = new AbortController();
    jest.spyOn(AbortSignal, 'timeout').mockReturnValueOnce(deadline.signal);
    const timing = start('hang');
    const second = await launched();
    deadline.abort();
    await expect(timing).rejects.toThrow(/timed out while loading the native profile/);
    await expectGone(second);
  });

  describe('graceful shutdown', () => {
    // A delivered kill skips native's interrupt on Windows (TerminateProcess), so disposal must let native end itself first.
    it('ends a disposed Host through native\'s own interrupt before any kill, after reading a CRLF-terminated launch URL', async () => {
      const hostProcess = await start('serve', { FAKE_DSH_INTERRUPTS: join(root, 'interrupts.log'), FAKE_DSH_EOL: '\r\n' });
      const invocation = await launched();
      expect(await hostProcess.client.call('session/modelCatalog')).toBe('session/modelCatalog answered');
      await hostProcess.dispose();
      expect(await readFile(join(root, 'interrupts.log'), 'utf8')).toBe(`${JSON.stringify({ pid: invocation.pid, by: 'owner' })}\n`);
      await expectGone(invocation);
    });

    // Waits out the real grace period, then the forced stop.
    it('still stops a Host that outlives its owner\'s end of stdin', async () => {
      const hostProcess = await start('untethered');
      const invocation = await launched();
      await expect(hostProcess.dispose()).resolves.toBeUndefined();
      await expectGone(invocation);
    }, 20_000);
  });
});
