import * as childProcess from 'node:child_process';
import * as fs from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import { createServer, type Server } from 'node:net';
import * as path from 'node:path';

import { NativePeer } from '@test/helpers/deepseek/NativePeer';
import { createWindowsHostFS } from '@test/helpers/WindowsHostFS';
import { WSLProcessFixture, type WSLProcessRequest } from '@test/helpers/WSLProcessFixture';
import spawn from 'cross-spawn';

import type { ExecutionTarget } from '@/core/process/execution-target/types';
import { LoopbackSessionToolServer } from '@/core/session-tools/LoopbackSessionToolServer';
import { resolveDeepSeekExecutionContext } from '@/providers/deepseek/runtime/DeepSeekExecutionContext';
import { DeepSeekHost } from '@/providers/deepseek/runtime/DeepSeekHost';
import { DeepSeekHostProcess } from '@/providers/deepseek/runtime/DeepSeekHostProcess';

vi.mock('cross-spawn', () => ({ default: vi.fn() }));
// The Host launch spawns directly through Node rather than cross-spawn; both reach the same wsl.exe boundary.
vi.mock('node:child_process', async importOriginal => ({ ...await importOriginal<typeof childProcess>(), spawn: vi.fn() }));
// WindowsHostFS serves the profile under `\\wsl$` and the launch artifacts under `C:\Temp` on POSIX hosts.
vi.mock('fs', async () => ({ ...await vi.importActual<typeof import('fs')>('fs') }));
vi.mock('fs/promises', async () => ({ ...await vi.importActual<typeof import('fs/promises')>('fs/promises') }));

const ENTRY = '/usr/lib/node_modules/@deepseek-ai/dsh/dist/cli.js';
const POWERSHELL = '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe';
const target: ExecutionTarget = { method: 'wsl', distroName: 'Ubuntu', platformOs: 'linux', platformFamily: 'unix' };
const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
const environment = { PATH: 'C:\\Windows\\System32', DSH_API_KEY: 'private-key' };
const isLaunch = (request: WSLProcessRequest) => request.executable === '/usr/bin/node' && request.argv[0] === ENTRY;

const PROFILE = '/home/alice/.dsh/profiles/web/package.json';

// WindowsHostFS models Windows paths only on POSIX hosts.
describe.skipIf(path.sep === '\\')('DeepSeek WSL host process', () => {
  let wsl: WSLProcessFixture;
  let peer: NativePeer;
  let server: LoopbackSessionToolServer;
  let files: ReturnType<typeof createWindowsHostFS>;
  let launchOutput: () => string;
  let host: DeepSeekHost | undefined;
  let launched: childProcess.ChildProcess | undefined;

  beforeEach(async () => {
    files = createWindowsHostFS({ fs, fsPromises });
    await files.write(files.fromLinux(PROFILE), '{}');
    // Launch artifacts go to the Windows temp directory, as on a Windows host.
    await fsPromises.mkdir('C:\\Temp', { recursive: true });
    vi.stubEnv('TMPDIR', 'C:\\Temp');
    peer = new NativePeer();
    peer.onCall = method => method === 'session/list' ? { items: [] } : {};
    await peer.open();
    server = new LoopbackSessionToolServer();
    launchOutput = () => `${peer.url}\n`;
    wsl = new WSLProcessFixture();
    wsl.environment = { HOME: '/home/alice' };
    wsl.binaries.set('dsh', { path: '/usr/bin/dsh', version: 'dsh 0.2.0' });
    wsl.binaries.set('node', { path: '/usr/bin/node', version: 'v24.16.0' });
    wsl.reply = request => {
      if (request.executable === '/usr/bin/node' && request.argv[0] === '-e') return { stdout: JSON.stringify(ENTRY) };
      // dsh prints its authenticated loopback launch URL, here the shared native peer's.
      return isLaunch(request) ? { hold: true, stdout: launchOutput() } : undefined;
    };
    vi.mocked(spawn).mockReset().mockImplementation(wsl.spawn);
    vi.mocked(childProcess.spawn).mockReset().mockImplementation((command: string, args: readonly string[], options: childProcess.SpawnOptions) => {
      const child = wsl.spawn(command, args, options);
      const request = wsl.requests.at(-1)!;
      if (!isLaunch(request)) throw new Error('Only the Host launch spawns directly');
      launched = child;
      // Native's lifecycle plugin exits dsh when Claudian closes its end of stdin.
      child.stdin!.once('finish', () => request.complete({}));
      return child;
    });
    vi.stubEnv('SystemRoot', 'C:\\Windows');
    Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
  });
  afterEach(async () => {
    await host?.dispose();
    host = undefined;
    launched = undefined;
    Object.defineProperty(process, 'platform', platform);
    vi.unstubAllEnvs();
    await server?.close(); await peer?.close();
  });

  async function startHost(): Promise<DeepSeekHost> {
    const execution = await resolveDeepSeekExecutionContext(target, 'C:\\Vault', environment, '');
    host = new DeepSeekHost(async () => ({ cliPath: 'dsh', cwd: 'C:\\Vault', environment, execution }), DeepSeekHostProcess.start, 60_000, server);
    return host;
  }

  it('boots Linux npm dsh through Linux Node with a credential-free call relay and exits it by closing stdin', async () => {
    const deepseek = await startHost();
    const lease = await deepseek.attach();
    const launch = wsl.requests.find(isLaunch)!;
    expect(wsl.requests.map(request => [request.executable, request.argv.at(-1)])).toEqual([
      ['/usr/bin/awk', 'DSH_HOME'], [POWERSHELL, expect.any(String)],
      ['/bin/sh', 'dsh'], ['/usr/bin/dsh', '--version'], ['/bin/sh', 'node'], ['/usr/bin/node', '--version'],
      ['/usr/bin/node', '/usr/bin/dsh'], ['/usr/bin/node', '0'],
    ]);
    for (const request of wsl.requests) expect(request.args).toEqual(expect.arrayContaining(['--distribution', 'Ubuntu', '--cd', '/mnt/c/Vault']));
    const patch = launch.argv[4];
    expect(launch.argv).toEqual([ENTRY, '--profile', 'web', '--patch', patch, '--no-open', '--port', '0']);
    expect(patch).toMatch(/^\/mnt\/c\/Temp\/claudian-deepseek-[^/]+\/claudian\.patch\.json$/u);
    const artifacts = files.fromLinux(path.posix.dirname(patch));
    // Route credentials live only in the private endpoint file the sessions plugin rereads per call.
    const route = JSON.parse(await files.read(path.win32.join(artifacts, 'session-tools.json')));
    const env = launch.options.env!;
    for (const secret of [route.url, route.routeId]) {
      expect(JSON.stringify([env, launch.args, launch.stdin])).not.toContain(secret);
    }
    expect(JSON.parse(env.CLAUDIAN_DEEPSEEK_SESSION_RELAY!)).toEqual({ command: POWERSHELL, args: expect.arrayContaining(['-EncodedCommand']), env: {
      WSLENV: 'CLAUDIAN_SESSION_TOOL_URL:CLAUDIAN_SESSION_TOOL_ROUTE:CLAUDIAN_SESSION_TOOL_MODE', CLAUDIAN_SESSION_TOOL_MODE: 'call',
    } });
    expect(env.WSLENV?.split(':')).toEqual(expect.arrayContaining(['CLAUDIAN_DEEPSEEK_SESSION_RELAY', 'DSH_API_KEY']));
    // The Windows PATH is not enhanced with host Node/CLI directories for a Linux launch.
    expect(env.PATH).toBe(environment.PATH);
    expect(peer.calls.map(call => call.method)).toContain('session/list');

    lease.release();
    await deepseek.dispose();
    expect(launched).toMatchObject({ killed: false, exitCode: 0 });
    expect(fs.existsSync(artifacts)).toBe(false);
  });

  it.each([
    ['Linux Node is missing', () => { wsl.binaries.delete('node'); }, /Linux Node\.js and the npm @deepseek-ai\/dsh package/],
    ['the Linux Web profile is missing', () => files.remove(files.fromLinux(PROFILE)), /Web profile is unavailable in WSL\. WSL requires Linux Node\.js/],
  ])('reports WSL guidance without launching when %s', async (_name, arrange, message) => {
    await arrange();
    await expect((await startHost()).attach()).rejects.toThrow(message);
    expect(wsl.requests.some(isLaunch)).toBe(false);
  });

  it('explains WSL localhost forwarding when the printed launch URL is unreachable and stops the launch', async () => {
    // A held loopback port whose connections reset, as when WSL does not forward the distro's listener.
    const resetting: Server = createServer(socket => socket.resetAndDestroy());
    await new Promise<void>(resolve => resetting.listen(0, '127.0.0.1', resolve));
    onTestFinished(() => new Promise<void>(resolve => resetting.close(() => resolve())));
    const { port } = resetting.address() as { port: number };
    launchOutput = () => `http://127.0.0.1:${port}/?token=fixture\n`;
    await expect((await startHost()).attach()).rejects.toThrow(/inside WSL through localhost.*localhostForwarding/);
    // The unauthenticated launch is shut down rather than left running in the distro.
    expect(launched).toMatchObject({ killed: true, signalCode: 'SIGTERM' });
  });

});
