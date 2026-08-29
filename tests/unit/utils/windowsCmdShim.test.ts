import { EventEmitter } from 'node:events';

import {
  resolveWindowsCmdShimSpawnSpec,
  terminateSpawnedProcessTree,
} from '@/utils/windowsCmdShim';

describe('windowsCmdShim', () => {
  const originalPlatform = process.platform;

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform });
  });

  it('preserves explicit process-tree ownership for native Windows executables', () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });

    expect(resolveWindowsCmdShimSpawnSpec({
      args: ['status'],
      command: 'C:\\Program Files\\Git\\cmd\\git.exe',
      killProcessTree: true,
    })).toEqual({
      args: ['status'],
      command: 'C:\\Program Files\\Git\\cmd\\git.exe',
      killProcessTree: true,
    });
  });

  it('rejects multiline arguments instead of corrupting them through cmd.exe', () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });

    expect(() => resolveWindowsCmdShimSpawnSpec({
      args: ['--system-prompt', 'first line\nsecond line', '--session', 'session.jsonl'],
      command: 'C:\\Users\\dev\\AppData\\Roaming\\npm\\pi.cmd',
    })).toThrow('Windows command shims cannot safely receive multiline arguments');
  });

  it('keeps command-shell metacharacters in structured arguments for cross-spawn', () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });

    expect(resolveWindowsCmdShimSpawnSpec({
      args: ['%PATH% & calc'],
      command: 'C:\\Program Files\\agent.cmd',
    })).toEqual({
      args: ['%PATH% & calc'],
      command: 'C:\\Program Files\\agent.cmd',
      killProcessTree: true,
    });
  });

  it('waits for taskkill to finish terminating the Windows process tree', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    const proc = { kill: jest.fn().mockReturnValue(true), pid: 4312 };
    const taskkill = new EventEmitter();
    const spawnProcess = jest.fn().mockReturnValue(taskkill);

    let settled = false;
    const termination = terminateSpawnedProcessTree(
      proc,
      'SIGTERM',
      spawnProcess,
      { args: [], command: 'git.exe', killProcessTree: true },
    ).then(result => {
      settled = true;
      return result;
    });

    await Promise.resolve();
    expect(settled).toBe(false);
    expect(spawnProcess).toHaveBeenCalledWith(
      'taskkill.exe',
      ['/pid', '4312', '/t', '/f'],
      { stdio: 'ignore', windowsHide: true },
    );

    taskkill.emit('close', 0);

    await expect(termination).resolves.toBe(true);
    expect(proc.kill).not.toHaveBeenCalled();
  });

  it('settles after a bounded deadline with a direct kill when taskkill never emits', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    const proc = { kill: jest.fn().mockReturnValue(true), pid: 4312 };
    const taskkill = new EventEmitter();
    const spawnProcess = jest.fn().mockReturnValue(taskkill);

    const termination = terminateSpawnedProcessTree(
      proc,
      'SIGTERM',
      spawnProcess,
      { args: [], command: 'git.exe', killProcessTree: true },
      { taskkillTimeoutMs: 20 },
    );

    await expect(termination).resolves.toBe(true);
    expect(proc.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('does not fire the deadline fallback after a normal taskkill completion', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    const proc = { kill: jest.fn().mockReturnValue(true), pid: 4312 };
    const taskkill = new EventEmitter();
    const spawnProcess = jest.fn().mockReturnValue(taskkill);

    const termination = terminateSpawnedProcessTree(
      proc,
      'SIGTERM',
      spawnProcess,
      { args: [], command: 'git.exe', killProcessTree: true },
      { taskkillTimeoutMs: 20 },
    );
    taskkill.emit('close', 0);
    await expect(termination).resolves.toBe(true);

    await new Promise(resolve => setTimeout(resolve, 60));
    expect(proc.kill).not.toHaveBeenCalled();
  });
});
