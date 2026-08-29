import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

jest.mock('cross-spawn', () => jest.fn());

import spawn from 'cross-spawn';

import { GitCommandRunner } from '@/app/collab/git/GitCommandRunner';

const mockSpawn = spawn as jest.MockedFunction<typeof spawn>;

function createMockGitProcess(): ChildProcessWithoutNullStreams {
  const child = new EventEmitter() as unknown as ChildProcessWithoutNullStreams;
  Object.assign(child, {
    pid: 9876,
    stderr: new PassThrough(),
    stdin: new PassThrough(),
    stdout: new PassThrough(),
  });
  child.kill = jest.fn().mockReturnValue(true);
  return child;
}

describe('GitCommandRunner Windows process ownership', () => {
  const originalPlatform = process.platform;

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform });
    jest.clearAllMocks();
  });

  it('does not settle cancellation until native Git tree termination completes', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    const git = createMockGitProcess();
    const taskkill = new EventEmitter();
    mockSpawn
      .mockReturnValueOnce(git)
      .mockReturnValueOnce(taskkill as ReturnType<typeof spawn>);
    const runner = new GitCommandRunner({
      emptyConfigPath: 'C:\\empty.gitconfig',
      executablePath: 'C:\\Program Files\\Git\\cmd\\git.exe',
    });
    const controller = new AbortController();
    let settled = false;

    const execution = runner.run({
      args: ['status'],
      cwd: 'C:\\vault',
      signal: controller.signal,
    }).catch(error => {
      settled = true;
      throw error;
    });
    controller.abort();
    git.emit('close', null);

    await Promise.resolve();
    expect(settled).toBe(false);
    expect(runner.activeProcessCount).toBe(1);
    expect(mockSpawn).toHaveBeenNthCalledWith(
      2,
      'taskkill.exe',
      ['/pid', '9876', '/t', '/f'],
      { stdio: 'ignore', windowsHide: true },
    );

    taskkill.emit('close', 0);

    await expect(execution).rejects.toMatchObject({ code: 'cancelled' });
    expect(runner.activeProcessCount).toBe(0);
  });

  it('settles cancellation after the bounded deadline when taskkill never emits', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    const git = createMockGitProcess();
    const taskkill = new EventEmitter();
    mockSpawn
      .mockReturnValueOnce(git)
      .mockReturnValueOnce(taskkill as ReturnType<typeof spawn>);
    const runner = new GitCommandRunner({
      emptyConfigPath: 'C:\\empty.gitconfig',
      executablePath: 'C:\\Program Files\\Git\\cmd\\git.exe',
      taskkillTimeoutMs: 20,
    });
    const controller = new AbortController();

    const execution = runner.run({
      args: ['status'],
      cwd: 'C:\\vault',
      signal: controller.signal,
    });
    controller.abort();
    git.emit('close', null);

    await expect(execution).rejects.toMatchObject({ code: 'cancelled' });
    expect(runner.activeProcessCount).toBe(0);
    expect(git.kill).toHaveBeenCalledWith('SIGTERM');
  });
});
