import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { Readable, Writable } from 'node:stream';

jest.mock('node:child_process', () => ({
  spawn: jest.fn(),
}));

import { spawn } from 'node:child_process';

import { ManagedStdioProcess } from '@/core/process/ManagedStdioProcess';

const mockSpawn = spawn as jest.MockedFunction<typeof spawn>;

function createMockProcess(): ChildProcessWithoutNullStreams {
  const proc = new EventEmitter() as unknown as ChildProcessWithoutNullStreams;
  Object.assign(proc, {
    exitCode: null,
    killed: false,
    pid: 12345,
    signalCode: null,
    stderr: new Readable({ read() {} }),
    stdin: new Writable({ write: (_chunk, _encoding, callback) => callback() }),
    stdout: new Readable({ read() {} }),
  });
  proc.kill = jest.fn().mockReturnValue(true);
  return proc;
}

function createManagedProcess(
  overrides: Partial<ConstructorParameters<typeof ManagedStdioProcess>[0]> = {},
): ManagedStdioProcess {
  return new ManagedStdioProcess({
    args: ['serve', '--stdio'],
    command: '/usr/bin/provider',
    cwd: '/workspace',
    env: { PATH: '/usr/bin' },
    ...overrides,
  });
}

describe('ManagedStdioProcess', () => {
  const originalPlatform = process.platform;
  let proc: ChildProcessWithoutNullStreams;

  beforeEach(() => {
    jest.clearAllMocks();
    proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform });
    jest.useRealTimers();
  });

  it('starts once and exposes the owned stdio streams and liveness state', () => {
    const managed = createManagedProcess();

    managed.start();
    managed.start();

    expect(mockSpawn).toHaveBeenCalledTimes(1);
    expect(mockSpawn).toHaveBeenCalledWith(
      '/usr/bin/provider',
      ['serve', '--stdio'],
      expect.objectContaining({
        cwd: '/workspace',
        env: { PATH: '/usr/bin' },
        stdio: 'pipe',
        windowsHide: true,
      }),
    );
    expect(managed.stdin).toBe(proc.stdin);
    expect(managed.stdout).toBe(proc.stdout);
    expect(managed.stderr).toBe(proc.stderr);
    expect(managed.isStarted()).toBe(true);
    expect(managed.isAlive()).toBe(true);
    expect(managed.getExitState()).toBeNull();
  });

  it('does not spawn after shutdown was requested before start', async () => {
    const managed = createManagedProcess();

    await managed.shutdown();
    managed.start();

    expect(mockSpawn).not.toHaveBeenCalled();
    expect(managed.isStarted()).toBe(false);
  });

  it('records a synchronous spawn failure and does not retry the start', () => {
    const error = new Error('spawn threw');
    mockSpawn.mockImplementationOnce(() => {
      throw error;
    });
    const managed = createManagedProcess();
    const onError = jest.fn();
    managed.onError(onError);

    expect(() => managed.start()).toThrow(error);
    expect(() => managed.start()).not.toThrow();

    expect(mockSpawn).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(error);
    expect(managed.isStarted()).toBe(false);
    expect(managed.isAlive()).toBe(false);
    expect(managed.getExitState()).toEqual({
      closed: true,
      code: null,
      error,
      signal: null,
    });
  });

  it('observes operational errors without treating them as process exit', () => {
    const managed = createManagedProcess();
    const onError = jest.fn();
    const onExit = jest.fn();
    const onClose = jest.fn();
    managed.onError(onError);
    managed.onExit(onExit);
    managed.onClose(onClose);
    managed.start();

    const error = new Error('spawn failed');
    proc.emit('error', error);
    expect(managed.isAlive()).toBe(true);
    expect(onError).toHaveBeenCalledWith(error);
    expect(onClose).not.toHaveBeenCalled();

    proc.emit('exit', 1, null);
    expect(onExit).toHaveBeenCalledWith({
      closed: false,
      code: 1,
      error,
      signal: null,
    });

    proc.emit('close', 1, null);
    expect(onClose).toHaveBeenCalledWith({
      closed: true,
      code: 1,
      error,
      signal: null,
    });
    expect(managed.getExitState()).toEqual({
      closed: true,
      code: 1,
      error,
      signal: null,
    });
  });

  it('marks an asynchronously failed spawn as not alive', () => {
    Object.assign(proc, { pid: undefined });
    const managed = createManagedProcess();
    managed.start();

    const error = new Error('spawn ENOENT');
    proc.emit('error', error);

    expect(managed.isAlive()).toBe(false);
    expect(managed.getExitState()).toEqual({
      closed: false,
      code: null,
      error,
      signal: null,
    });
  });

  it('retains only the configured stderr tail and removes its listener after close', () => {
    const managed = createManagedProcess({ stderrBufferLimit: 8 });
    managed.start();

    proc.stderr.emit('data', '  abcdefghijk  ');
    expect(managed.getStderrSnapshot()).toBe('fghijk');
    expect(proc.stderr.listenerCount('data')).toBe(1);

    proc.emit('close', 0, null);
    expect(proc.stderr.listenerCount('data')).toBe(0);
  });

  it('wraps Windows command shims and terminates their process tree', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    const managed = createManagedProcess({
      args: ['serve', 'R&D'],
      command: 'C:\\Users\\R&D\\provider.cmd',
      cwd: 'C:\\workspace',
    });
    managed.start();

    const shutdown = managed.shutdown();

    expect(mockSpawn).toHaveBeenNthCalledWith(
      1,
      process.env.ComSpec || process.env.comspec || 'cmd.exe',
      ['/d', '/s', '/c', '""C:\\Users\\R&D\\provider.cmd" serve "R&D""'],
      expect.objectContaining({ windowsVerbatimArguments: true }),
    );
    expect(mockSpawn).toHaveBeenNthCalledWith(
      2,
      'taskkill.exe',
      ['/pid', '12345', '/t', '/f'],
      { stdio: 'ignore', windowsHide: true },
    );
    expect(proc.kill).not.toHaveBeenCalled();

    proc.emit('exit', 0, null);
    await shutdown;
  });

  it('performs one graceful shutdown for repeated calls', async () => {
    const managed = createManagedProcess();
    managed.start();

    const first = managed.shutdown();
    const second = managed.shutdown();
    expect(proc.kill).toHaveBeenCalledTimes(1);
    expect(proc.kill).toHaveBeenCalledWith('SIGTERM');

    proc.emit('exit', 0, 'SIGTERM');
    await expect(Promise.all([first, second])).resolves.toEqual([undefined, undefined]);
    expect(proc.kill).toHaveBeenCalledTimes(1);
  });

  it('continues SIGKILL escalation when signal delivery emits an error', async () => {
    jest.useFakeTimers();
    const managed = createManagedProcess();
    managed.start();

    const shutdown = managed.shutdown();
    proc.emit('error', new Error('kill EPERM'));

    expect(managed.isAlive()).toBe(true);
    jest.advanceTimersByTime(3_000);
    expect(proc.kill).toHaveBeenNthCalledWith(1, 'SIGTERM');
    expect(proc.kill).toHaveBeenNthCalledWith(2, 'SIGKILL');

    proc.emit('exit', 0, 'SIGKILL');
    await expect(shutdown).resolves.toBeUndefined();
  });

  it('escalates to SIGKILL and settles at the final shutdown deadline', async () => {
    jest.useFakeTimers();
    const managed = createManagedProcess();
    managed.start();

    const shutdown = managed.shutdown();
    jest.advanceTimersByTime(3_000);
    expect(proc.kill).toHaveBeenNthCalledWith(1, 'SIGTERM');
    expect(proc.kill).toHaveBeenNthCalledWith(2, 'SIGKILL');

    jest.advanceTimersByTime(3_000);
    await expect(shutdown).resolves.toBeUndefined();
    expect(proc.listenerCount('error')).toBe(0);
    expect(proc.listenerCount('exit')).toBe(0);
    expect(proc.listenerCount('close')).toBe(0);
  });
});
