import '@/providers';

import { createProviderHostFixture } from '@test/helpers/providerRuntimeHost';

import { getInstallationKey } from '@/core/device/InstallationKey';
import { ProviderRegistry } from '@/core/providers/ProviderRegistry';

it.each([
  ['host-native', String.raw`C:\Vault`, String.raw`C:\Vault`],
  ['wsl', String.raw`C:\Vault`, '/mnt/c/Vault'],
  ['wsl', String.raw`\\wsl$\Ubuntu\home\alice\Vault`, '/home/alice/Vault'],
] as const)('projects Pi %s cwd %s for shared prompt consumers', async (method, hostCwd, expected) => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', { value: 'win32' });
  try {
    const key = getInstallationKey();
    const { host } = await createProviderHostFixture({ settings: { providerConfigs: { pi: {
      installationMethodsByHost: { [key]: method }, wslDistroOverridesByHost: { [key]: 'Ubuntu' },
    } } } });
    expect(await ProviderRegistry.resolveExecutionWorkingDirectory(host, 'pi', hostCwd)).toBe(expected);
  } finally { Object.defineProperty(process, 'platform', platform); }
});
