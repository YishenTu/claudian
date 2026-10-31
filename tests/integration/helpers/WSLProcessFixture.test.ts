// @test-ci {"native":true}
import { type ChildProcess,spawn as spawnProcess } from 'node:child_process';
import { once } from 'node:events';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { WSLProcessFixture } from '@test/helpers/WSLProcessFixture';
import spawn from 'cross-spawn';

import { buildTargetLaunchSpec } from '@/core/process/execution-target/TargetLaunchSpec';
import { runProcessProbe } from '@/core/process/ProcessProbe';
import { SESSION_TOOL_RELAY_COMMAND } from '@/core/session-tools/sessionToolRelayCommand';

vi.mock('cross-spawn', () => ({ default: vi.fn() }));

const launch = buildTargetLaunchSpec({
  target: { method: 'wsl', distroName: 'Ubuntu', platformFamily: 'unix', platformOs: 'linux' },
  command: '/usr/local/bin/agent', args: ['--serve'], hostCwd: 'C:\\vault', env: {},
});

let native: WSLProcessFixture;
beforeEach(() => {
  native = new WSLProcessFixture();
  native.reply = () => ({ hold: true });
});

function start(options = {}): ChildProcess {
  return native.spawn(launch.command, launch.args, { windowsVerbatimArguments: true, ...options });
}

it('reports a kill through exit and close only after kill() returns, like a real child', async () => {
  const child = start();
  const events: unknown[] = [];
  child.on('exit', (...args) => events.push(['exit', ...args]));
  child.on('close', (...args) => events.push(['close', ...args]));
  expect(child.kill()).toBe(true);
  expect([child.killed, child.signalCode, events]).toEqual([true, null, []]);
  await once(child, 'close');
  expect(events).toEqual([['exit', null, 'SIGTERM'], ['close', null, 'SIGTERM']]);
  expect(child.signalCode).toBe('SIGTERM');
  expect(child.kill()).toBe(false);
});

it('announces spawn on nextTick and exits a default reply only on a later turn', async () => {
  native.reply = () => ({ stdout: 'done' });
  const child = start();
  const events: string[] = [];
  child.on('spawn', () => events.push('spawn'));
  child.on('exit', () => events.push('exit'));
  // A later tick still precedes the exit, so listeners attached after it see the whole lifecycle.
  await new Promise(resolve => process.nextTick(resolve));
  expect(events).toEqual(['spawn']);
  child.on('close', () => events.push('close'));
  await once(child, 'close');
  expect(events).toEqual(['spawn', 'exit', 'close']);
});

it('lets an accepted kill win over a reply that had not yet exited', async () => {
  native.reply = () => ({ stdout: 'late' });
  const child = start();
  child.kill('SIGKILL');
  expect(await once(child, 'exit')).toEqual([null, 'SIGKILL']);
});

it.each([[9, 'SIGKILL'], [2, 'SIGINT'], ['SIGQUIT', 'SIGQUIT'], ['sigterm', 'SIGTERM']] as const)('publishes signal %j as %s', async (signal, name) => {
  const child = start();
  child.kill(signal as NodeJS.Signals | number);
  expect(await once(child, 'exit')).toEqual([null, name]);
});

it('treats signal 0 as a liveness probe and rejects signals it cannot deliver', async () => {
  const child = start();
  expect(child.kill(0)).toBe(true);
  expect(child.killed).toBe(true);
  expect(() => child.kill(99_999)).toThrow(expect.objectContaining({ code: 'ERR_UNKNOWN_SIGNAL' }));
  expect(() => child.kill('SIGUSR1')).toThrow(expect.objectContaining({ code: 'ENOSYS', syscall: 'kill' }));
  native.requests[0].complete({ stdout: 'alive', code: 3 });
  expect(await once(child, 'exit')).toEqual([3, null]);
});

it('records stdin and holds a process until the test completes it', async () => {
  const child = start();
  const output: string[] = [];
  child.stdout?.setEncoding('utf8').on('data', (chunk: string) => output.push(chunk));
  child.stdin?.write('{"id":1}\n');
  child.stdin?.end('{"id":2}\n');
  await once(child.stdin!, 'finish');
  await new Promise(resolve => setImmediate(resolve));
  expect([native.requests[0].stdin, child.exitCode]).toEqual(['{"id":1}\n{"id":2}\n', null]);
  native.requests[0].complete({ stdout: 'done\n' });
  await once(child, 'close');
  expect(output.join('')).toBe('done\n');
});

it('bounds a held process through a real probe deadline and its termination', async () => {
  vi.mocked(spawn).mockImplementation(native.spawn);
  native.reply = () => ({ stdout: 'partial', hold: true });
  const closed = new Promise<unknown[]>(resolve => {
    vi.mocked(spawn).mockImplementationOnce((...args: Parameters<typeof native.spawn>) => {
      const child = native.spawn(...args);
      child.on('close', (...result) => resolve(result));
      return child;
    });
  });
  expect(await runProcessProbe({ ...launch, cwd: launch.spawnCwd }, 10)).toBeNull();
  expect(await closed).toEqual([null, 'SIGTERM']);
});

it('rejects detached launches, which would signal a host process group for the fake pid', () => {
  expect(() => start({ detached: true })).toThrow('Detached WSL process groups are not modeled');
});

it('streams held output in response to stdin on later turns and rejects output after exit', async () => {
  let request: Parameters<NonNullable<WSLProcessFixture['reply']>>[0] | undefined;
  native.reply = next => { request = next; return { hold: true }; };
  const child = start();
  const output: string[] = [];
  const delivered = once(child.stdout!.setEncoding('utf8').on('data', (chunk: string) => output.push(chunk)), 'data');
  request!.onStdin(chunk => request!.write(`echo:${chunk}`));
  child.stdin!.write('ping');
  // Output never arrives inside the client's write.
  expect(output).toEqual([]);
  await delivered;
  expect(output).toEqual(['echo:ping']);
  expect(request!.stdin).toBe('ping');
  child.kill();
  await once(child, 'close');
  expect(() => request!.write('late')).toThrow('output has ended');
});

describe('Windows PowerShell interop', () => {
  const powershell = '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe';
  const encoded = Buffer.from(SESSION_TOOL_RELAY_COMMAND, 'utf16le').toString('base64');
  function launchSpec(env: Record<string, string>, script = encoded) {
    return buildTargetLaunchSpec({
      target: { method: 'wsl', distroName: 'Ubuntu', platformFamily: 'unix', platformOs: 'linux' },
      command: powershell, args: ['-NoProfile', '-EncodedCommand', script], hostCwd: 'C:\\vault', env,
    });
  }
  function probe(env: Record<string, string>) {
    const spec = launchSpec(env);
    return runProcessProbe({ ...spec, cwd: spec.spawnCwd }, 1_000);
  }
  beforeEach(() => { native.reply = undefined; vi.mocked(spawn).mockReset().mockImplementation(native.spawn); });

  it('answers the relay readiness probe only when WSLENV forwards its mode to Windows', async () => {
    expect(await probe({ CLAUDIAN_SESSION_TOOL_MODE: 'probe', WSLENV: 'CLAUDIAN_SESSION_TOOL_MODE' })).toBe('claudian-relay-ready\r\n');
    expect(await probe({ CLAUDIAN_SESSION_TOOL_MODE: 'probe' })).toBeNull();
  });

  it('fails like a distro with interop disabled', async () => {
    native.interop = false;
    expect(await probe({ CLAUDIAN_SESSION_TOOL_MODE: 'probe', WSLENV: 'CLAUDIAN_SESSION_TOOL_MODE' })).toBeNull();
  });

  it('rejects PowerShell programs it does not model', () => {
    const spec = launchSpec({}, Buffer.from('Write-Output ok', 'utf16le').toString('base64'));
    expect(() => native.spawn(spec.command, spec.args, { windowsVerbatimArguments: true })).toThrow('Unsupported PowerShell invocation');
  });
});

it('reports WSLENV-imported values over the distro environment, with HOME from the launcher copy', async () => {
  native.reply = undefined;
  vi.mocked(spawn).mockReset().mockImplementation(native.spawn);
  native.environment = { HOME: '/home/distro', TOKEN: 'distro', KEPT: 'distro' };
  const read = (env: Record<string, string>) => {
    const spec = buildTargetLaunchSpec({ target: launch.target, command: '/usr/bin/awk', args: ['program', 'HOME', 'TOKEN', 'KEPT'], hostCwd: 'C:\\vault', env });
    return runProcessProbe({ ...spec, cwd: spec.spawnCwd }, 5_000);
  };
  expect(await read({ HOME: '/home/host', TOKEN: 'host', KEPT: 'host', WSLENV: 'TOKEN:KEPT/w' }))
    .toBe('x\0/home/distro\0x\0host\0x\0distro\0');
  // The real launch spec adds the CLAUDIAN_WSL_HOME copy that survives WSL init.
  expect(await read({ HOME: '/home/host', WSLENV: 'HOME' })).toBe('x\0/home/host\0x\0distro\0x\0distro\0');
});

it('translates /p and /l drive paths the way wsl.exe imports them', async () => {
  native.reply = undefined;
  vi.mocked(spawn).mockReset().mockImplementation(native.spawn);
  const spec = buildTargetLaunchSpec({ target: launch.target, command: '/usr/bin/awk', args: ['program', 'STORE', 'ROOT'], hostCwd: 'C:\\vault',
    env: { STORE: 'D:\\DeepSeek Home', ROOT: 'E:\\', WSLENV: 'STORE/p:ROOT/p' } });
  expect(await runProcessProbe({ ...spec, cwd: spec.spawnCwd }, 5_000)).toBe('x\0/mnt/d/DeepSeek Home\0x\0/mnt/e/\0');
});

// Upstream WslEnv test: both flags share the list translator (microsoft/WSL test/windows/wsl/UnitTests.cpp).
it.each(['p', 'l', 'pl', 'lp'])('translates a ;-separated drive list under /%s', async flags => {
  native.reply = undefined;
  vi.mocked(spawn).mockReset().mockImplementation(native.spawn);
  const spec = buildTargetLaunchSpec({ target: launch.target, command: '/usr/bin/awk', args: ['program', 'PATHS'], hostCwd: 'C:\\vault',
    env: { PATHS: 'C:\\Users;C:\\Windows', WSLENV: `PATHS/${flags}` } });
  expect(await runProcessProbe({ ...spec, cwd: spec.spawnCwd }, 5_000)).toBe('x\0/mnt/c/Users:/mnt/c/Windows\0');
});

it('reports a bare drive, which WSL skips as a relative path, as unmodeled', async () => {
  native.reply = undefined;
  vi.mocked(spawn).mockReset().mockImplementation(native.spawn);
  const unmodeled: Error[] = [];
  native.onUnmodeled = error => { unmodeled.push(error); };
  const spec = buildTargetLaunchSpec({ target: launch.target, command: '/usr/bin/awk', args: ['program', 'DRIVE'], hostCwd: 'C:\\vault',
    env: { DRIVE: 'E:', WSLENV: 'DRIVE/p' } });
  expect(await runProcessProbe({ ...spec, cwd: spec.spawnCwd }, 5_000)).toBeNull();
  expect(unmodeled.map(error => error.message)).toEqual(['Path-translated WSLENV value is not modeled: DRIVE']);
});

// A UNC share is a Windows path form the fixture does not translate.
function readTranslatedToken() {
  vi.mocked(spawn).mockReset().mockImplementation(native.spawn);
  native.reply = undefined;
  const spec = buildTargetLaunchSpec({ target: launch.target, command: '/usr/bin/awk', args: ['program', 'TOKEN'], hostCwd: 'C:\\vault',
    env: { TOKEN: '\\\\server\\share\\token', WSLENV: 'TOKEN/p' } });
  return runProcessProbe({ ...spec, cwd: spec.spawnCwd }, 5_000);
}

it('reports a path-translated WSLENV read to its sink even though the probe only sees a failed launch', async () => {
  const unmodeled: Error[] = [];
  native.onUnmodeled = error => { unmodeled.push(error); };
  expect(await readTranslatedToken()).toBeNull();
  expect(unmodeled.map(error => error.message)).toEqual(['Path-translated WSLENV value is not modeled: TOKEN']);
});

// The default sink fails the test that reached the unmodeled path.
it.fails('fails the running test by default when a probe reads a path-translated WSLENV value', async () => {
  // Passes on its own (the sink test above proves the null); only the default sink can fail it.
  expect(await readTranslatedToken()).toBeNull();
});


describe.skipIf(path.sep === '\\')('external executable projection', () => {
  async function run(env: Record<string, string>, omitPrivateHome = false) {
    const cwd = await fs.mkdtemp(path.join(tmpdir(), 'wsl cwd with spaces '));
    onTestFinished(() => fs.rm(cwd, { recursive: true, force: true }));
    native.environment = { HOME: '/home/distro' };
    native.execute = request => spawnProcess(process.execPath, request.argv, { cwd: request.cwd, env: request.env });
    vi.mocked(spawn).mockImplementation(native.spawn);
    const spec = buildTargetLaunchSpec({
      target: launch.target, command: process.execPath,
      args: ['-e', 'process.stdout.write(JSON.stringify({ cwd: process.cwd(), home: process.env.HOME, list: process.env.LIST }))'],
      hostCwd: '\\\\wsl$\\Ubuntu' + cwd.replaceAll('/', '\\'), env,
    });
    if (omitPrivateHome) delete spec.env.CLAUDIAN_WSL_HOME;
    const output = await runProcessProbe({ ...spec, cwd: spec.spawnCwd }, 5_000);
    expect(output).not.toBeNull();
    return { result: JSON.parse(output!), cwd: await fs.realpath(cwd) };
  }

  it('decodes the space-containing cwd before launching an external process', async () => {
    const { result, cwd } = await run({});
    expect(result.cwd).toBe(cwd);
    expect(native.requests[0].distro).toBe('Ubuntu');
  });

  it('applies /l list forwarding before launching an external process', async () => {
    const { result } = await run({ LIST: 'C:\\Users;C:\\Windows', WSLENV: 'LIST/l' });
    expect(result.list).toBe('/mnt/c/Users:/mnt/c/Windows');
  });

  it('restores private HOME and otherwise preserves the distro HOME for external processes', async () => {
    const env = { HOME: '/home/configured', WSLENV: 'HOME' };
    expect((await run(env)).result.home).toBe('/home/configured');
    expect((await run(env, true)).result.home).toBe('/home/distro');
  });
});
