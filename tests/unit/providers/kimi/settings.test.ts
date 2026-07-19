import {
  DEFAULT_KIMI_PROVIDER_SETTINGS,
  getKimiProviderSettings,
  updateKimiProviderSettings,
} from '@/providers/kimi/settings';

jest.mock('@/utils/env', () => ({
  ...jest.requireActual('@/utils/env'),
  getHostnameKey: () => 'current-host',
  getLegacyHostnameKey: () => 'legacy-host',
}));

describe('kimi settings', () => {
  it('defaults to disabled with empty host paths', () => {
    const settings = getKimiProviderSettings({});
    expect(settings.enabled).toBe(false);
    expect(settings.cliPath).toBe('');
    expect(settings.cliPathsByHost).toEqual({});
    expect(DEFAULT_KIMI_PROVIDER_SETTINGS.enabled).toBe(false);
  });

  it('normalizes host-scoped CLI paths and migrates legacy cliPath writes', () => {
    const bag: Record<string, unknown> = {};
    updateKimiProviderSettings(bag, {
      cliPath: '/opt/kimi',
      enabled: true,
    });

    const settings = getKimiProviderSettings(bag);
    expect(settings.enabled).toBe(true);
    expect(settings.cliPathsByHost['current-host']).toBe('/opt/kimi');
    expect(settings.cliPath).toBe('');
  });

  it('updates host path map without clobbering other hosts', () => {
    const bag: Record<string, unknown> = {
      providerConfigs: {
        kimi: {
          enabled: true,
          cliPathsByHost: {
            'other-host': '/other/kimi',
          },
        },
      },
    };

    updateKimiProviderSettings(bag, {
      cliPathsByHost: {
        'other-host': '/other/kimi',
        'current-host': '/current/kimi',
      },
    });

    const settings = getKimiProviderSettings(bag);
    expect(settings.cliPathsByHost).toEqual({
      'other-host': '/other/kimi',
      'current-host': '/current/kimi',
    });
  });
});
