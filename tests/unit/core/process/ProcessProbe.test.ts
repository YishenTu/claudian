import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

jest.mock('cross-spawn', () => jest.fn());

import spawn from 'cross-spawn';

import { runProcessProbe } from '@/core/process/ProcessProbe';

function childProcess() {
  const child = Object.assign(new EventEmitter(), {
    pid: 123,
    exitCode: null,
    signalCode: null,
    killed: false,
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: jest.fn((signal: string) => {
      child.emit('exit', null, signal);
      child.emit('close', null, signal);
      return true;
    }),
  });
  return child;
}

describe('process probe bounds', () => {
  afterEach(() => { jest.useRealTimers(); });

  it('terminates a command that does not finish within the deadline', async () => {
    jest.useFakeTimers();
    const child = childProcess();
    jest.mocked(spawn).mockReturnValueOnce(child as never);
    const result = runProcessProbe({ command: 'test', args: [], cwd: '/tmp', env: {} }, 50);
    await jest.advanceTimersByTimeAsync(50);
    expect(await result).toBeNull();
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('terminates a command that exceeds the output limit', async () => {
    const child = childProcess();
    jest.mocked(spawn).mockReturnValueOnce(child as never);
    const result = runProcessProbe({ command: 'test', args: [], cwd: '/tmp', env: {} });
    child.stdout.write('x'.repeat(16_385));
    expect(await result).toBeNull();
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
  });
});
