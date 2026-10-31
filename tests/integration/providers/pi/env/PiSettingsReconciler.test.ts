// @test-ci {"native":true}
import '@/providers';

import { createWSLDistroFixture } from '@test/helpers/WSLProcessFixture';

import { getInstallationKey } from '@/core/device/InstallationKey';
import { ProviderSettingsCoordinator } from '@/core/providers/ProviderSettingsCoordinator';

// Default-distro discovery runs the fixture's real wsl.exe on POSIX hosts; Windows hosts have the real one.
it.skipIf(process.platform === 'win32')('keeps a UNC-inferred Pi target when the unrelated default distro changes', async () => {
  const distros = await createWSLDistroFixture(Buffer.from('* Ubuntu    Running    2', 'utf16le'));
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', { value: 'win32' });
  try {
    const settings = { providerConfigs: { pi: { enabled: true, cliPath: '', cliPathsByHost: {}, environmentVariables: '',
      installationMethodsByHost: { [getInstallationKey()]: 'wsl' } } } };
    const context = { vaultPath: String.raw`\\wsl$\Debian\home\alice\Vault` };
    ProviderSettingsCoordinator.reconcileProviders(settings, ['pi'], context);
    await distros.setOutput(Buffer.from('* Fedora    Running    2', 'utf16le'));
    expect(ProviderSettingsCoordinator.reconcileProviders(settings, ['pi'], context))
      .toMatchObject({ changed: false, sessionInvalidationProviderIds: [] });
    expect(ProviderSettingsCoordinator.reconcileProviders(settings, ['pi'], {
      vaultPath: String.raw`\\wsl$\Alpine\home\alice\Vault`,
    })).toMatchObject({ changed: true, sessionInvalidationProviderIds: ['pi'] });
  } finally { Object.defineProperty(process, 'platform', platform); }
});
