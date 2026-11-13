// @test-ci {"native":true}
import '@/providers';

import { DEFAULT_CLAUDIAN_SETTINGS } from '@test/helpers/defaultSettings';
import { createWSLDistroFixture } from '@test/helpers/WSLProcessFixture';

import { RuntimeSettingsCoordinator } from '@/app/settings/RuntimeSettingsCoordinator';
import { SettingsCoordinator } from '@/app/settings/SettingsCoordinator';
import { getInstallationKey } from '@/core/device/InstallationKey';

// The distro fixture is a POSIX executable standing in for wsl.exe.
it.skipIf(process.platform === 'win32').each([
  ['codex', 'UNC vault', '\\\\wsl$\\Ubuntu\\home\\linux\\vault', false],
  ['codex', 'drive vault', 'C:\\Vault', true],
  ['claude', 'UNC vault', '\\\\wsl$\\Ubuntu\\home\\linux\\vault', false],
  ['claude', 'drive vault', 'C:\\Vault', true],
] as const)('uses the effective distro for %s when reconciling a %s', async (providerId, _name, vaultPath, restarts) => {
  const distros = await createWSLDistroFixture(Buffer.from('* Debian  Running  2', 'utf16le'));
  const platform = process.platform;
  Object.defineProperty(process, 'platform', { value: 'win32' });
  try {
    const settings = structuredClone(DEFAULT_CLAUDIAN_SETTINGS);
    const key = getInstallationKey();
    settings.providerConfigs[providerId] = { ...settings.providerConfigs[providerId],
      installationMethodsByHost: { [key]: 'wsl' }, wslDistroOverridesByHost: {},
    };
    const runtime = new RuntimeSettingsCoordinator({
      settings: new SettingsCoordinator(settings, async () => {}, () => {}),
      getSettings: () => settings, getVaultPath: () => vaultPath,
    });
    runtime.reconcile([providerId]);
    await distros.setOutput(Buffer.from('* Fedora  Running  2', 'utf16le'));
    expect(runtime.reconcile([providerId]).environmentChangedProviderIds).toEqual(restarts ? [providerId] : []);
    settings.providerConfigs[providerId]!.wslDistroOverridesByHost = { [key]: 'Ubuntu' };
    expect(runtime.reconcile([providerId]).environmentChangedProviderIds).toEqual(restarts ? [providerId] : []);
  } finally { Object.defineProperty(process, 'platform', { value: platform }); }
});
