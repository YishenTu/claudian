import type { ChildProcess } from 'node:child_process';
import { once } from 'node:events';

import { WSLProcessFixture } from '@test/helpers/WSLProcessFixture';
import spawn from 'cross-spawn';

import { buildTargetLaunchSpec } from '@/core/process/execution-target/TargetLaunchSpec';
import { runProcessProbe } from '@/core/process/ProcessProbe';

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
