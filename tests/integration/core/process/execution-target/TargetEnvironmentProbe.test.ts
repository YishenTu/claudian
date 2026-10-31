import { WSLProcessFixture } from '@test/helpers/WSLProcessFixture';
import spawn from 'cross-spawn';

import { probeTargetEnvironment } from '@/core/process/execution-target/TargetEnvironmentProbe';

vi.mock('cross-spawn', () => ({ default: vi.fn() }));

const options = {
  target: { method: 'wsl', distroName: 'Ubuntu', platformFamily: 'unix', platformOs: 'linux' } as const,
  hostCwd: 'C:\\vault', env: {}, variables: ['HOME'],
};

let native: WSLProcessFixture;
beforeEach(() => { native = new WSLProcessFixture(); vi.mocked(spawn).mockReset().mockImplementation(native.spawn); });

it.each(['HOME;echo bad', '', '-v', 'A=B'])('rejects invalid variable name %j before launching a probe', async key => {
  await expect(probeTargetEnvironment({ ...options, variables: [key] })).rejects.toThrow('Invalid environment variable name');
  expect(spawn).not.toHaveBeenCalled();
});

it.each([null, '', 'x\0/home/me', 'x\0/home/me\0extra\0', '?\0/home/me\0'])('does not trust an unsuccessful or malformed probe (%j)', async output => {
  native.reply = () => output === null ? { code: 1 } : { stdout: output };
  expect(await probeTargetEnvironment(options)).toBeNull();
});

it('reads the configured native environment without starting a shell', async () => {
  expect(await probeTargetEnvironment({ ...options,
    target: { method: 'host-native', platformFamily: 'unix', platformOs: 'linux' },
    env: { HOME: '/native/home', EMPTY: '' }, variables: ['HOME', 'EMPTY', 'MISSING'],
  })).toEqual({ HOME: '/native/home', EMPTY: '', MISSING: undefined });
  expect(spawn).not.toHaveBeenCalled();
});

it('decodes present, empty and unset Linux values through the real process probe', async () => {
  native.environment = { HOME: '/home/linux', EMPTY: '', MULTILINE: 'a\nb' };
  expect(await probeTargetEnvironment({ ...options, variables: ['HOME', 'EMPTY', 'MISSING', 'MULTILINE'] }))
    .toEqual({ HOME: '/home/linux', EMPTY: '', MISSING: undefined, MULTILINE: 'a\nb' });
});

it('returns an empty projection without requiring a working WSL launch when no variables are requested', async () => {
  native.reply = () => ({ code: 1 });
  expect(await probeTargetEnvironment({ ...options, variables: [] })).toEqual({});
  expect(native.requests).toHaveLength(0);
});
