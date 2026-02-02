import { exec } from 'child_process';

import { BangBashService } from '@/features/chat/services/BangBashService';

jest.mock('child_process', () => ({
  exec: jest.fn(),
}));

const execMock = exec as jest.MockedFunction<typeof exec>;

describe('BangBashService', () => {
  let service: BangBashService;

  beforeEach(() => {
    service = new BangBashService('/test/dir', '/usr/bin');
  });

  afterEach(() => {
    jest.resetAllMocks();
  });

  it('should pass correct exec options', async () => {
    execMock.mockImplementation((_cmd: any, _opts: any, cb: any) => {
      cb(null, '', '');
      return undefined as any;
    });

    await service.execute('echo hello');

    expect(execMock).toHaveBeenCalledWith(
      'echo hello',
      expect.objectContaining({
        cwd: '/test/dir',
        env: expect.objectContaining({ PATH: '/usr/bin' }),
        timeout: 30_000,
        maxBuffer: 1024 * 1024,
        shell: process.platform === 'win32' ? 'cmd.exe' : '/bin/bash',
      }),
      expect.any(Function)
    );
  });

  it('should return stdout for a successful command', async () => {
    execMock.mockImplementation((_cmd: any, _opts: any, cb: any) => {
      cb(null, 'hello\n', '');
      return undefined as any;
    });

    const result = await service.execute('echo hello');
    expect(result.command).toBe('echo hello');
    expect(result.stdout.trim()).toBe('hello');
    expect(result.exitCode).toBe(0);
    expect(result.error).toBeUndefined();
  });

  it('should return non-zero exit code for a failing command', async () => {
    const error = Object.assign(new Error('Command failed'), { code: 2 });
    execMock.mockImplementation((_cmd: any, _opts: any, cb: any) => {
      cb(error, '', 'No such file');
      return undefined as any;
    });

    const result = await service.execute('ls /nonexistent');
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toBe('No such file');
  });

  it('should return exit code 1 when error has non-numeric code', async () => {
    const error = Object.assign(new Error('Command failed'), { code: 'ENOENT' });
    execMock.mockImplementation((_cmd: any, _opts: any, cb: any) => {
      cb(error, '', 'command not found');
      return undefined as any;
    });

    const result = await service.execute('nonexistent_cmd');
    expect(result.exitCode).toBe(1);
    expect(typeof result.exitCode).toBe('number');
  });

  it('should capture both stdout and stderr', async () => {
    execMock.mockImplementation((_cmd: any, _opts: any, cb: any) => {
      cb(null, 'out\n', 'err\n');
      return undefined as any;
    });

    const result = await service.execute('echo out && echo err >&2');
    expect(result.stdout.trim()).toBe('out');
    expect(result.stderr.trim()).toBe('err');
  });

  it('should handle timeout (killed process)', async () => {
    const error = Object.assign(new Error('Timed out'), { killed: true });
    execMock.mockImplementation((_cmd: any, _opts: any, cb: any) => {
      cb(error, '', '');
      return undefined as any;
    });

    const result = await service.execute('sleep 999');
    expect(result.exitCode).toBe(124);
    expect(result.error).toContain('timed out');
  });

  it('should handle maxBuffer exceeded (killed process with ERR_CHILD_PROCESS_STDIO_MAXBUFFER)', async () => {
    const error = Object.assign(new Error('maxBuffer'), {
      killed: true,
      code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
    });
    execMock.mockImplementation((_cmd: any, _opts: any, cb: any) => {
      cb(error, 'partial output', '');
      return undefined as any;
    });

    const result = await service.execute('cat /dev/urandom');
    expect(result.exitCode).toBe(124);
    expect(result.error).toContain('maximum buffer size');
    expect(result.stdout).toBe('partial output');
  });

  it('should surface error.message for non-zero exit', async () => {
    const error = Object.assign(new Error('Command failed: exit 1'), { code: 1 });
    execMock.mockImplementation((_cmd: any, _opts: any, cb: any) => {
      cb(error, '', '');
      return undefined as any;
    });

    const result = await service.execute('exit 1');
    expect(result.exitCode).toBe(1);
    expect(result.error).toBeDefined();
    expect(typeof result.error).toBe('string');
  });

  it('should handle null stdout/stderr gracefully', async () => {
    execMock.mockImplementation((_cmd: any, _opts: any, cb: any) => {
      cb(null, null, null);
      return undefined as any;
    });

    const result = await service.execute('test');
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('');
    expect(result.exitCode).toBe(0);
  });
});
