import '@/providers';

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
