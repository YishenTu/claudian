import '@/providers';

import * as childProcess from 'child_process';

import { getInstallationKey } from '@/core/device/InstallationKey';

vi.mock('child_process', async () => ({ ...await vi.importActual('child_process'), execFileSync: vi.fn() }));

import { DEFAULT_CLAUDIAN_SETTINGS } from '@test/helpers/defaultSettings';
import { testDate } from '@test/helpers/testClock';

import { RuntimeSettingsCoordinator } from '@/app/settings/RuntimeSettingsCoordinator';
import { SettingsCoordinator } from '@/app/settings/SettingsCoordinator';

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

it.each([
  ['UNC vault', '\\\\wsl$\\Ubuntu\\home\\linux\\vault', false],
  ['drive vault', 'C:\\Vault', true],
])('uses the effective distro when reconciling a %s', (_name, vaultPath, invalidates) => {
  const platform = process.platform;
  Object.defineProperty(process, 'platform', { value: 'win32' });
  try {
    const settings = structuredClone(DEFAULT_CLAUDIAN_SETTINGS);
    const key = getInstallationKey();
    settings.providerConfigs.codex = { ...settings.providerConfigs.codex,
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
    vi.mocked(childProcess.execFileSync).mockReturnValue(Buffer.from('* Debian  Running  2'));
    runtime.reconcile(['codex']);
    vi.mocked(childProcess.execFileSync).mockReturnValue(Buffer.from('* Fedora  Running  2'));
    expect(runtime.reconcile(['codex']).sessionInvalidationProviderIds).toEqual(invalidates ? ['codex'] : []);
    settings.providerConfigs.codex.wslDistroOverridesByHost = { [key]: 'Ubuntu' };
    expect(runtime.reconcile(['codex']).sessionInvalidationProviderIds).toEqual(invalidates ? ['codex'] : []);
  } finally { Object.defineProperty(process, 'platform', { value: platform }); vi.clearAllMocks(); }
});
