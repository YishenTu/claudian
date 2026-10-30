import { buildTargetLaunchSpec } from '@/core/process/execution-target/TargetLaunchSpec';

it('locates wsl.exe independently of an explicitly configured Linux PATH', () => {
  vi.stubEnv('SystemRoot', 'D:\\Windows');
  try {
    const spec = buildTargetLaunchSpec({
      target: { method: 'wsl', distroName: 'Ubuntu', platformFamily: 'unix', platformOs: 'linux' },
      hostCwd: 'C:\\vault', command: 'cli', args: [], env: { PATH: '/opt/cli:/usr/bin' },
      forwardEnvironment: [{ key: 'PATH' }],
    });
    expect(spec.command).toBe('D:\\Windows\\System32\\wsl.exe');
    expect(spec.env).toEqual({ PATH: '/opt/cli:/usr/bin', WSLENV: 'PATH' });
  } finally { vi.unstubAllEnvs(); }
});
