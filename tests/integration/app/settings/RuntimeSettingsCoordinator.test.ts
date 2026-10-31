// @test-ci {"native":true}
import '@/providers';

import { DEFAULT_CLAUDIAN_SETTINGS } from '@test/helpers/defaultSettings';
import { testDate } from '@test/helpers/testClock';
import { createWSLDistroFixture } from '@test/helpers/WSLProcessFixture';

import { RuntimeSettingsCoordinator } from '@/app/settings/RuntimeSettingsCoordinator';
import { SettingsCoordinator } from '@/app/settings/SettingsCoordinator';
import { getInstallationKey } from '@/core/device/InstallationKey';

it.each(['persistence', 'publication'] as const)(
  'keeps invalidation completion consistent with durable settings after %s fails',
  async failurePhase => {
    const generation = testDate().getTime();
    const settings = structuredClone(DEFAULT_CLAUDIAN_SETTINGS);
    settings.pendingProviderSessionInvalidations = { claude: generation };
    let durablePending = { ...settings.pendingProviderSessionInvalidations };
    const coordinator = new SettingsCoordinator(settings, async draft => {
      if (failurePhase === 'persistence') throw new Error('storage unavailable');
      durablePending = { ...draft.pendingProviderSessionInvalidations };
    }, () => { throw new Error('observer unavailable'); });
    const runtime = new RuntimeSettingsCoordinator({
      settings: coordinator,
      getSettings: () => settings,
      canCompleteInvalidations: () => true,
      executionLifecycle: { markSessionsInvalidated: () => undefined },
      conversations: {
        invalidateProviderSessions: () => [],
        persistProviderSessionInvalidations: async () => undefined,
      },
    });
    runtime.syncPendingSessionInvalidations();

    await expect(runtime.completePendingSessionInvalidations(new Map([['claude', generation]])))
      .rejects.toThrow(failurePhase === 'persistence' ? 'storage unavailable' : 'post-commit');

    const expected = failurePhase === 'persistence' ? { claude: generation } : {};
    expect(durablePending).toEqual(expected);
    expect(settings.pendingProviderSessionInvalidations).toEqual(expected);
    expect(Object.fromEntries(runtime.getPendingGenerations())).toEqual(expected);
  },
);

// The distro fixture is a POSIX executable standing in for wsl.exe.
it.skipIf(process.platform === 'win32').each([
  ['codex', 'UNC vault', '\\\\wsl$\\Ubuntu\\home\\linux\\vault', false],
  ['codex', 'drive vault', 'C:\\Vault', true],
  ['claude', 'UNC vault', '\\\\wsl$\\Ubuntu\\home\\linux\\vault', false],
  ['claude', 'drive vault', 'C:\\Vault', true],
] as const)('uses the effective distro for %s when reconciling a %s', async (providerId, _name, vaultPath, invalidates) => {
  const distros = await createWSLDistroFixture(Buffer.from('* Debian  Running  2', 'utf16le'));
  const platform = process.platform;
  Object.defineProperty(process, 'platform', { value: 'win32' });
  try {
    const settings = structuredClone(DEFAULT_CLAUDIAN_SETTINGS);
    const key = getInstallationKey();
    settings.providerConfigs[providerId] = { ...settings.providerConfigs[providerId],
      installationMethodsByHost: { [key]: 'wsl' }, wslDistroOverridesByHost: {},
    };
    const options = {
      settings: new SettingsCoordinator(settings, async () => {}, () => {}),
      getSettings: () => settings, getVaultPath: () => vaultPath,
      canCompleteInvalidations: () => true,
      executionLifecycle: { markSessionsInvalidated: () => undefined },
      conversations: { invalidateProviderSessions: () => [], persistProviderSessionInvalidations: async () => {} },
    };
    const runtime = new RuntimeSettingsCoordinator(options);
    runtime.reconcile([providerId]);
    await distros.setOutput(Buffer.from('* Fedora  Running  2', 'utf16le'));
    expect(runtime.reconcile([providerId]).sessionInvalidationProviderIds).toEqual(invalidates ? [providerId] : []);
    settings.providerConfigs[providerId]!.wslDistroOverridesByHost = { [key]: 'Ubuntu' };
    expect(runtime.reconcile([providerId]).sessionInvalidationProviderIds).toEqual(invalidates ? [providerId] : []);
  } finally { Object.defineProperty(process, 'platform', { value: platform }); }
});
