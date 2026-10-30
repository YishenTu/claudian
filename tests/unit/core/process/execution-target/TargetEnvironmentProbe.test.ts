import { probeTargetEnvironment } from '@/core/process/execution-target/TargetEnvironmentProbe';
import { runProcessProbe } from '@/core/process/ProcessProbe';

vi.mock('@/core/process/ProcessProbe', () => ({ runProcessProbe: vi.fn() }));

const options = {
  target: { method: 'wsl', distroName: 'Ubuntu', platformFamily: 'unix', platformOs: 'linux' } as const,
  hostCwd: 'C:\\vault', env: {}, variables: ['HOME'],
};

beforeEach(() => vi.mocked(runProcessProbe).mockReset());

it.each(['HOME;echo bad', '', '-v', 'A=B'])('rejects invalid variable name %j before launching a probe', async key => {
  await expect(probeTargetEnvironment({ ...options, variables: [key] })).rejects.toThrow('Invalid environment variable name');
  expect(runProcessProbe).not.toHaveBeenCalled();
});

it.each([null, '', 'x\0/home/me', 'x\0/home/me\0extra\0', '?\0/home/me\0'])('does not trust an unsuccessful or malformed probe (%j)', async output => {
  vi.mocked(runProcessProbe).mockResolvedValue(output);
  expect(await probeTargetEnvironment(options)).toBeNull();
});

it('reads the configured native environment without starting a shell', async () => {
  expect(await probeTargetEnvironment({ ...options,
    target: { method: 'host-native', platformFamily: 'unix', platformOs: 'linux' },
    env: { HOME: '/native/home', EMPTY: '' }, variables: ['HOME', 'EMPTY', 'MISSING'],
  })).toEqual({ HOME: '/native/home', EMPTY: '', MISSING: undefined });
  expect(runProcessProbe).not.toHaveBeenCalled();
});
