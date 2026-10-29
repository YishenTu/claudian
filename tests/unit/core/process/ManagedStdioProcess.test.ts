import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { Readable, Writable } from 'node:stream';

vi.mock('cross-spawn', () => ({ default: vi.fn() }));

import spawn from 'cross-spawn';
import type { MockedFunction } from 'vitest';

import { ManagedStdioProcess } from '@/core/process/ManagedStdioProcess';



const mockSpawn = spawn as MockedFunction<typeof spawn>;

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
  proc.kill = vi.fn().mockReturnValue(true);
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
    vi.clearAllMocks();
    proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform });
    vi.useRealTimers();
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
    const onError = vi.fn();
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
    const onError = vi.fn();
    const onExit = vi.fn();
    const onClose = vi.fn();
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

  it.each([
    { text: '\u4e2d', split: 1 },
    { text: '\u4e2d', split: 2 },
    { text: '\ud83d\ude80', split: 1 },
    { text: '\ud83d\ude80', split: 2 },
    { text: '\ud83d\ude80', split: 3 },
  ])('decodes $text split after byte $split without exposing incomplete bytes', ({ text, split }) => {
    const managed = createManagedProcess();
    managed.start();
    const bytes = Buffer.from(text, 'utf8');

    proc.stderr.emit('data', Buffer.from('prefix:'));
    proc.stderr.emit('data', bytes.subarray(0, split));
    expect(managed.getStderrSnapshot()).toBe('prefix:');
    proc.stderr.emit('data', bytes.subarray(split));
    expect(managed.getStderrSnapshot()).toBe(`prefix:${text}`);
    expect(managed.stderr).toBe(proc.stderr);
    proc.emit('close', 0, null);
    expect(managed.getStderrSnapshot()).toBe(`prefix:${text}`);
  });

  it.each([
    {
      name: 'complete buffers and strings',
      chunks: [Buffer.from('\u4e2d'), 'literal', Buffer.from('\ud83d\ude80')],
      expected: '\u4e2dliteral\ud83d\ude80',
    },
    {
      name: 'nonempty string flushes the pending prefix',
      chunks: [Buffer.from([0xe4]), 'literal', Buffer.from([0xb8, 0xad])],
      expected: '\ufffdliteral\ufffd\ufffd',
    },
    {
      name: 'empty string leaves the pending prefix intact',
      chunks: [Buffer.from([0xe4]), '', Buffer.from([0xb8, 0xad])],
      expected: '\u4e2d',
    },
  ])('preserves mixed stderr ordering: $name', ({ chunks, expected }) => {
    const managed = createManagedProcess();
    managed.start();

    for (const chunk of chunks) proc.stderr.emit('data', chunk);

    expect(managed.getStderrSnapshot()).toBe(expected);
    proc.emit('close', 0, null);
    expect(managed.getStderrSnapshot()).toBe(expected);
  });

  it('finalizes pending bytes before close observers and only once', () => {
    const managed = createManagedProcess();
    const snapshotAtClose = vi.fn(() => managed.getStderrSnapshot());
    managed.onClose(snapshotAtClose);
    managed.start();
    proc.stderr.emit('data', Buffer.from([0xe4, 0xb8]));
    expect(managed.getStderrSnapshot()).toBe('');

    proc.emit('close', 1, null);

    expect(snapshotAtClose).toHaveReturnedWith('\ufffd');
    expect(proc.stderr.listenerCount('data')).toBe(0);
    proc.emit('close', 1, null);
    proc.stderr.emit('data', Buffer.from('late'));
    expect(snapshotAtClose).toHaveBeenCalledTimes(1);
    expect(managed.getStderrSnapshot()).toBe('\ufffd');
  });

  it('keeps pending decoder bytes isolated between managed instances', () => {
    const otherProc = createMockProcess();
    mockSpawn.mockReturnValueOnce(proc).mockReturnValueOnce(otherProc);
    const first = createManagedProcess();
    const second = createManagedProcess();
    first.start();
    second.start();

    proc.stderr.emit('data', Buffer.from([0xe4]));
    otherProc.stderr.emit('data', Buffer.from([0xb8, 0xad]));
    proc.stderr.emit('data', Buffer.from([0xb8, 0xad]));

    expect(first.getStderrSnapshot()).toBe('\u4e2d');
    expect(second.getStderrSnapshot()).toBe('\ufffd\ufffd');
    proc.emit('close', 0, null);
    otherProc.emit('close', 0, null);
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
      'C:\\Users\\R&D\\provider.cmd',
      ['serve', 'R&D'],
      expect.not.objectContaining({ shell: true }),
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
    vi.useFakeTimers();
    const managed = createManagedProcess();
    managed.start();

    const shutdown = managed.shutdown();
    proc.emit('error', new Error('kill EPERM'));

    expect(managed.isAlive()).toBe(true);
    vi.advanceTimersByTime(3_000);
    expect(proc.kill).toHaveBeenNthCalledWith(1, 'SIGTERM');
    expect(proc.kill).toHaveBeenNthCalledWith(2, 'SIGKILL');

    proc.emit('exit', 0, 'SIGKILL');
    await expect(shutdown).resolves.toBeUndefined();
  });

  it('escalates to SIGKILL and settles at the final shutdown deadline', async () => {
    vi.useFakeTimers();
    const managed = createManagedProcess();
    managed.start();
    proc.stderr.emit('data', Buffer.from([0xe4, 0xb8]));
    expect(managed.getStderrSnapshot()).toBe('');

    const shutdown = managed.shutdown();
    vi.advanceTimersByTime(3_000);
    expect(proc.kill).toHaveBeenNthCalledWith(1, 'SIGTERM');
    expect(proc.kill).toHaveBeenNthCalledWith(2, 'SIGKILL');

    vi.advanceTimersByTime(3_000);
    await expect(shutdown).resolves.toBeUndefined();
    expect(managed.getStderrSnapshot()).toBe('\ufffd');
    expect(proc.stderr.listenerCount('data')).toBe(0);
    await managed.shutdown();
    proc.stderr.emit('data', Buffer.from('late'));
    expect(managed.getStderrSnapshot()).toBe('\ufffd');
    expect(proc.listenerCount('error')).toBe(0);
    expect(proc.listenerCount('exit')).toBe(0);
    expect(proc.listenerCount('close')).toBe(0);
  });
});
