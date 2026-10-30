import { WSLProcessFixture } from '@test/helpers/WSLProcessFixture';
import spawn from 'cross-spawn';

import { resolveGrokHistoryEnvironment } from '@/providers/grok/history/GrokHistoryEnvironment';

vi.mock('cross-spawn', () => ({ default: vi.fn() }));

const target = { method: 'wsl', distroName: 'Ubuntu', platformFamily: 'unix', platformOs: 'linux' } as const;
let native: WSLProcessFixture;
beforeEach(() => {
  native = new WSLProcessFixture();
  native.environment = { HOME: '/home/alice', GROK_HOME: '/opt/grok' };
  vi.mocked(spawn).mockReset().mockImplementation(native.spawn);
});

it('probes the Linux store with the forwarded Grok environment at the vault cwd', async () => {
  const resolved = await resolveGrokHistoryEnvironment({
    environment: { GROK_PROFILE: 'review', GROK_UNSET: undefined, HOME: '/custom/home', OTHER: 'host' }, environmentText: 'HOME=/custom/home',
    hostPlatform: 'win32', vaultPath: 'C:\\vault',
  }, target);
  expect(resolved).toMatchObject({ environment: { HOME: '/home/alice', GROK_HOME: '/opt/grok' }, target, targetCwd: '/mnt/c/vault' });
  const [probe] = native.requests;
  expect(native.requests).toHaveLength(1);
  expect(probe.args).toEqual(expect.arrayContaining(['--distribution', 'Ubuntu', '--cd', '/mnt/c/vault']));
  expect(probe.options.env?.WSLENV?.split(':').sort()).toEqual(['CLAUDIAN_WSL_HOME', 'GROK_PROFILE', 'HOME']);
});

it.each([
  ['no vault', { vaultPath: undefined }, target, undefined],
  ['a vault outside the distro', { vaultPath: '\\\\wsl$\\Debian\\vault' }, target, undefined],
  ['no resolved distro', { vaultPath: 'C:\\vault' }, { ...target, distroName: undefined }, '/mnt/c/vault'],
] as const)('returns an empty Linux environment without probing for %s', async (_name, context, resolvedTarget, targetCwd) => {
  const resolved = await resolveGrokHistoryEnvironment({ environment: { HOME: 'C:\\Users\\me' }, hostPlatform: 'win32', ...context }, resolvedTarget);
  expect(resolved.environment).toEqual({});
  expect(resolved.targetCwd).toBe(targetCwd);
  expect(native.requests).toEqual([]);
});

it('keeps the host environment for native targets', async () => {
  const context = { environment: { HOME: '/home/me' }, hostPlatform: 'linux' as const, vaultPath: '/vault' };
  expect(await resolveGrokHistoryEnvironment(context, { method: 'host-native', platformFamily: 'unix', platformOs: 'linux' })).toBe(context);
  expect(native.requests).toEqual([]);
});
