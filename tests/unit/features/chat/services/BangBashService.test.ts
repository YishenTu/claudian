import { BangBashService } from '@/features/chat/services/BangBashService';

describe('BangBashService', () => {
  let service: BangBashService;

  beforeEach(() => {
    service = new BangBashService(process.cwd(), process.env.PATH ?? '');
  });

  it('should return stdout for a successful command', async () => {
    const result = await service.execute('echo hello');
    expect(result.command).toBe('echo hello');
    expect(result.stdout.trim()).toBe('hello');
    expect(result.exitCode).toBe(0);
    expect(result.error).toBeUndefined();
  });

  it('should return stderr and non-zero exit code for a failing command', async () => {
    const result = await service.execute('ls /nonexistent_path_12345');
    expect(result.exitCode).not.toBe(0);
    expect(typeof result.exitCode).toBe('number');
  });

  it('should return exit code 1 for command not found via shell', async () => {
    const result = await service.execute('totally_nonexistent_command_xyz_12345');
    expect(result.exitCode).toBeGreaterThan(0);
    expect(typeof result.exitCode).toBe('number');
    expect(result.stderr).toBeTruthy();
  });

  it('should capture both stdout and stderr', async () => {
    const result = await service.execute('echo out && echo err >&2');
    expect(result.stdout.trim()).toBe('out');
    expect(result.stderr.trim()).toBe('err');
  });

  it('should always return exitCode as a number', async () => {
    const result = await service.execute('exit 42');
    expect(typeof result.exitCode).toBe('number');
    expect(result.exitCode).toBe(42);
  });

  it('should surface error.message for non-zero exit', async () => {
    const result = await service.execute('exit 1');
    expect(result.exitCode).toBe(1);
    expect(result.error).toBeDefined();
    expect(typeof result.error).toBe('string');
  });
});
