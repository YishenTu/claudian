import { EventEmitter } from 'node:events';
import { Readable, Writable } from 'node:stream';

jest.mock('node:child_process', () => ({
  spawn: jest.fn(),
}));

import { spawn } from 'node:child_process';

import { PiSubprocess } from '@/providers/pi/runtime/PiSubprocess';

const mockSpawn = spawn as jest.MockedFunction<typeof spawn>;

function createMockProcess(): any {
  const proc = new EventEmitter() as any;
  proc.stdin = new Writable({ write: (_chunk, _encoding, callback) => callback() });
  proc.stdout = new Readable({ read() {} });
  proc.stderr = new Readable({ read() {} });
  proc.exitCode = null;
  proc.killed = false;
  proc.kill = jest.fn((signal?: string) => {
    proc.killed = signal === 'SIGKILL';
    return true;
  });
  return proc;
}

describe('PiSubprocess', () => {
  let proc: any;

  beforeEach(() => {
    jest.clearAllMocks();
    proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('spawns Pi RPC with the launch spec args, cwd, stdio, and enhanced PATH', () => {
    const subprocess = new PiSubprocess({
      args: ['--mode', 'rpc'],
      command: '/opt/pi/bin/pi',
      cwd: '/vault',
      env: { PATH: '/usr/bin' },
    });

    subprocess.start();

    expect(mockSpawn).toHaveBeenCalledWith('/opt/pi/bin/pi', ['--mode', 'rpc'], expect.objectContaining({
      cwd: '/vault',
      stdio: 'pipe',
      windowsHide: true,
      env: expect.objectContaining({
        PATH: expect.stringContaining('/usr/bin'),
      }),
    }));
  });

  it('keeps a bounded stderr snapshot for runtime errors', () => {
    const subprocess = new PiSubprocess({
      args: ['--mode', 'rpc'],
      command: 'pi',
      cwd: '/vault',
      env: {},
    });
    subprocess.start();

    proc.stderr.emit('data', 'a'.repeat(9_000));

    expect(subprocess.getStderrSnapshot()).toHaveLength(8_000);
  });

  it('notifies close listeners and escalates shutdown after timeout', async () => {
    jest.useFakeTimers();
    const subprocess = new PiSubprocess({
      args: ['--mode', 'rpc'],
      command: 'pi',
      cwd: '/vault',
      env: {},
    });
    const onClose = jest.fn();
    subprocess.onClose(onClose);
    subprocess.start();

    const shutdown = subprocess.shutdown();
    expect(proc.kill).toHaveBeenCalledWith('SIGTERM');

    jest.advanceTimersByTime(3_000);
    expect(proc.kill).toHaveBeenCalledWith('SIGKILL');

    proc.exitCode = 1;
    proc.emit('exit', 1, 'SIGKILL');
    await shutdown;

    expect(onClose).toHaveBeenCalledWith(expect.any(Error));
  });
});
