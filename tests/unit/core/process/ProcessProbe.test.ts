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

  it.each([0, 16_382])('preserves split UTF-8 bytes after %i ASCII bytes', async prefixLength => {
    const child = childProcess();
    jest.mocked(spawn).mockReturnValueOnce(child as never);
    const result = runProcessProbe({ command: 'test', args: [], cwd: '/tmp', env: {} });
    child.stdout.write(Buffer.concat([Buffer.alloc(prefixLength, 120), Buffer.from([0xc3])]));
    child.stdout.write(Buffer.from([0xa9]));
    child.emit('exit', 0, null);
    child.emit('close', 0, null);

    expect(await result).toBe('x'.repeat(prefixLength) + 'é');
  });

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

  it('accepts stdout exactly at the byte limit across multiple chunks', async () => {
    const child = childProcess();
    jest.mocked(spawn).mockReturnValueOnce(child as never);
    const result = runProcessProbe({ command: 'test', args: [], cwd: '/tmp', env: {} });
    child.stdout.write('x'.repeat(8_192));
    child.stdout.write('y'.repeat(8_192));
    child.emit('exit', 0, null);
    child.emit('close', 0, null);

    expect(await result).toBe('x'.repeat(8_192) + 'y'.repeat(8_192));
  });

  it('bounds output by UTF-8 bytes rather than character count', async () => {
    const child = childProcess();
    jest.mocked(spawn).mockReturnValueOnce(child as never);
    const result = runProcessProbe({ command: 'test', args: [], cwd: '/tmp', env: {} });
    child.stdout.write('é'.repeat(8_193));
    child.emit('exit', 0, null);
    child.emit('close', 0, null);

    expect(await result).toBeNull();
  });
});
