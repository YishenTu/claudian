// @test-ci {"native":true}
import { createWSLDistroFixture } from '@test/helpers/WSLProcessFixture';

import { getInstallationKey } from '@/core/device/InstallationKey';
import { grokSettingsReconciler } from '@/providers/grok/env/GrokSettingsReconciler';

// The distro fixture is a POSIX executable standing in for wsl.exe.
it.skipIf(process.platform === 'win32').each([
  ['UNC vault', '\\\\wsl$\\Ubuntu\\vault', { changed: false }],
  ['drive vault', 'C:\\vault', { changed: true, sessionPolicy: 'invalidate' }],
] as const)('uses the effective distro when reconciling a %s', async (_name, vaultPath, defaultDistroChange) => {
  const distros = await createWSLDistroFixture(Buffer.from('* Debian  Running  2', 'utf16le'));
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
  try {
    const settings = { providerConfigs: { grok: { enabled: true, installationMethodsByHost: { [getInstallationKey()]: 'wsl' } } } };
    grokSettingsReconciler.reconcileModelWithEnvironment(settings, { vaultPath });
    await distros.setOutput(Buffer.from('* Fedora  Running  2', 'utf16le'));
    expect(grokSettingsReconciler.reconcileModelWithEnvironment(settings, { vaultPath })).toEqual(defaultDistroChange);
    expect(grokSettingsReconciler.reconcileModelWithEnvironment(settings, { vaultPath: '\\\\wsl$\\Debian\\vault' }))
      .toEqual({ changed: true, sessionPolicy: 'invalidate' });
  } finally { Object.defineProperty(process, 'platform', platform); }
});
