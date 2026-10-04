import {
  resolveWindowsCmdShimSpawnSpec,
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

});
