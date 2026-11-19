import { createProviderHostFixture } from '@test/helpers/providerRuntimeHost';
import { readWSLExec } from '@test/helpers/WSLLaunch';

import { getInstallationKey } from '@/core/device/InstallationKey';
import { ProviderRegistry } from '@/core/providers/ProviderRegistry';
import { registerProviderModules } from '@/core/providers/registerProviderModules';
import { antigravityProviderRegistration } from '@/providers/antigravity/registration';
import { resolveAntigravityLaunchSpec } from '@/providers/antigravity/runtime/AntigravityExecutionContext';
import { claudeProviderRegistration } from '@/providers/claude/registration';

registerProviderModules([claudeProviderRegistration, antigravityProviderRegistration]);

const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
beforeEach(() => { Object.defineProperty(process, 'platform', { ...platform, value: 'win32' }); });
afterEach(() => { Object.defineProperty(process, 'platform', platform); vi.unstubAllEnvs(); });

async function wslHost(antigravity: Record<string, unknown> = {}) {
  const key = getInstallationKey();
  const { host } = await createProviderHostFixture({ settings: { providerConfigs: { antigravity: {
    enabled: true, installationMethodsByHost: { [key]: 'wsl' }, wslDistroOverridesByHost: { [key]: 'Ubuntu' }, ...antigravity,
  } } } });
  return host;
}

it('launches agy in the resolved distro with a Linux CLI reference and explicitly forwarded environment', async () => {
  vi.stubEnv('WSLENV', undefined);
  vi.stubEnv('GEMINI_FROM_HOST', 'host');
  vi.stubEnv('MY_GEMINI_TOKEN', 'not-antigravity-owned');
  const host = await wslHost({
    cliPathsByHost: { [getInstallationKey()]: '~/cli with spaces/agy' },
    environmentVariables: 'GEMINI_API_KEY=secret\nPATH=/linux/bin:/usr/bin\nHOME=C:/Users/me',
  });
  const spec = await resolveAntigravityLaunchSpec(host.getRuntimeHost('antigravity'), ['acp'], 'C:\\vault');
  expect(spec.target).toMatchObject({ method: 'wsl', distroName: 'Ubuntu' });
  expect(spec.targetCwd).toBe('/mnt/c/vault');
  expect(readWSLExec(spec).args.slice(-2)).toEqual(['~/cli with spaces/agy', 'acp']);
  // Linux keeps its own PATH: the Windows-enhanced PATH must not replace it.
  expect(spec.env.PATH).toBe('/linux/bin:/usr/bin');
  const forwarded = (spec.env.WSLENV ?? '').split(':');
  expect(forwarded).toEqual(expect.arrayContaining(['GEMINI_API_KEY', 'GEMINI_FROM_HOST', 'PATH']));
  // A Windows-shaped HOME never replaces the Linux home that holds agy's store.
  expect(forwarded.some(entry => entry.startsWith('HOME'))).toBe(false);
  expect(forwarded).not.toContain('MY_GEMINI_TOKEN');
  expect(spec.args.join(' ')).not.toContain('secret');
});

it('ignores a Windows CLI path saved for the native installation', async () => {
  const host = await wslHost({ cliPathsByHost: { [getInstallationKey()]: 'C:\\Users\\me\\AppData\\Local\\agy\\agy.exe' } });
  const spec = await resolveAntigravityLaunchSpec(host.getRuntimeHost('antigravity'), ['acp'], 'C:\\vault');
  expect(readWSLExec(spec).args.slice(-2)).toEqual(['agy', 'acp']);
});

it.each([
  ['C:\\vault', '/mnt/c/vault'],
  ['\\\\wsl$\\Ubuntu\\home\\alice\\vault', '/home/alice/vault'],
])('projects the prompt working directory %s to the same cwd used by launch', async (hostCwd, expected) => {
  const host = await wslHost();
  const promptCwd = await ProviderRegistry.resolveExecutionWorkingDirectory(host, 'antigravity', hostCwd);
  const launch = await resolveAntigravityLaunchSpec(host.getRuntimeHost('antigravity'), [], hostCwd);
  expect(promptCwd).toBe(expected);
  expect(launch.targetCwd).toBe(expected);
});

it('rejects a vault the selected distro cannot address', async () => {
  const host = await wslHost();
  await expect(ProviderRegistry.resolveExecutionWorkingDirectory(host, 'antigravity', '\\\\wsl$\\Debian\\vault'))
    .rejects.toThrow('cannot be represented in the selected WSL distro');
});

it('keeps native working directories and the resolved native CLI', async () => {
  // Pin a non-Windows host: on real win32 the native target is `native-windows`, not `host-native`.
  Object.defineProperty(process, 'platform', { ...platform, value: 'linux' });
  const { host } = await createProviderHostFixture({ settings: { providerConfigs: { antigravity: { enabled: true } } } });
  expect(await ProviderRegistry.resolveExecutionWorkingDirectory(host, 'antigravity', '/vault')).toBe('/vault');
  const spec = await resolveAntigravityLaunchSpec(host.getRuntimeHost('antigravity'), ['acp'], '/vault');
  expect([spec.target.method, spec.command, spec.targetCwd]).toEqual(['host-native', 'agy', '/vault']);
});
