import { ChildProcess } from 'node:child_process';
import { Readable, Writable } from 'node:stream';

vi.mock('cross-spawn', () => ({ default: vi.fn() }));

import spawn from 'cross-spawn';
import type { MockedFunction } from 'vitest';

import { ACPSubprocess } from '@/providers/acp/ACPSubprocess';



const mockSpawn = spawn as MockedFunction<typeof spawn>;

function createMockProcess() {
  const proc = Object.assign(new ChildProcess(), {
    stdin: new Writable({ write: (_chunk, _encoding, callback) => callback() }),
    stdout: new Readable({ read() {} }),
    stderr: new Readable({ read() {} }),
    exitCode: null as number | null,
    killed: false,
    pid: 12345 as number | undefined,
  });
  proc.kill = vi.fn(() => true);
  return proc;
}

describe('ACPSubprocess', () => {
  const originalPlatform = process.platform;
  let proc: ReturnType<typeof createMockProcess>;

  beforeEach(() => {
    vi.clearAllMocks();
    proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform });
  });

  it('spawns ACP runtimes directly on non-Windows commands', () => {
    const subprocess = new ACPSubprocess({
      args: ['agent', '--no-leader', 'stdio'],
      command: '/opt/grok/bin/grok',
      cwd: '/vault',
      env: { PATH: '/usr/bin' },
    });

    subprocess.start();

    expect(mockSpawn).toHaveBeenCalledWith('/opt/grok/bin/grok', ['agent', '--no-leader', 'stdio'], expect.objectContaining({
      cwd: '/vault',
      stdio: 'pipe',
      windowsHide: true,
    }));
  });

  it('passes Windows .cmd shims to cross-spawn', () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    const subprocess = new ACPSubprocess({
      args: ['agent', '--no-leader', 'stdio'],
      command: 'C:\\Users\\R&D\\AppData\\Roaming\\npm\\grok.cmd',
      cwd: 'C:\\Vault',
      env: { PATH: 'C:\\Windows\\System32' },
    });

    subprocess.start();

    expect(mockSpawn).toHaveBeenCalledWith(
      'C:\\Users\\R&D\\AppData\\Roaming\\npm\\grok.cmd',
      ['agent', '--no-leader', 'stdio'],
      expect.objectContaining({
        cwd: 'C:\\Vault',
        windowsHide: true,
      }),
    );
  });

  it('kills the process tree when shutting down Windows .cmd shims', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    const subprocess = new ACPSubprocess({
      args: ['agent', '--no-leader', 'stdio'],
      command: 'C:\\Users\\R&D\\AppData\\Roaming\\npm\\grok.cmd',
      cwd: 'C:\\Vault',
      env: { PATH: 'C:\\Windows\\System32' },
    });
    subprocess.start();

    const shutdown = subprocess.shutdown();

    expect(mockSpawn).toHaveBeenCalledWith(
      'taskkill.exe',
      ['/pid', '12345', '/t', '/f'],
      expect.objectContaining({
        stdio: 'ignore',
        windowsHide: true,
      }),
    );
    expect(proc.kill).not.toHaveBeenCalled();

    proc.exitCode = 0;
    proc.emit('exit', 0, null);
    await shutdown;
  });
});
