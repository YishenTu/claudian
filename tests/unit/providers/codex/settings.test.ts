import {
  DEFAULT_CODEX_PROVIDER_SETTINGS,
  getCodexProviderSettings,
  updateCodexProviderSettings,
} from '@/providers/codex/settings';

const mockGetHostnameKey = jest.fn(() => 'host-a');

jest.mock('@/utils/env', () => ({
  getHostnameKey: () => mockGetHostnameKey(),
}));

describe('codex settings', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('defaults installationMethod to native-windows and leaves wslDistroOverride empty', () => {
    const settings = getCodexProviderSettings({});

    expect(settings.installationMethod).toBe('native-windows');
    expect(settings.wslDistroOverride).toBe('');
    expect(settings.installationMethod).toBe(DEFAULT_CODEX_PROVIDER_SETTINGS.installationMethod);
    expect(settings.wslDistroOverride).toBe(DEFAULT_CODEX_PROVIDER_SETTINGS.wslDistroOverride);
  });

  it('normalizes invalid installationMethod and wslDistroOverride values', () => {
    const settings = getCodexProviderSettings({
      providerConfigs: {
        codex: {
          installationMethod: 'auto',
          wslDistroOverride: 123,
        },
      },
    });

    expect(settings.installationMethod).toBe('native-windows');
    expect(settings.wslDistroOverride).toBe('');
  });

  it('does not inherit another host installation method once host-scoped values exist', () => {
    const settings = getCodexProviderSettings({
      providerConfigs: {
        codex: {
          installationMethodsByHost: {
            'host-b': 'wsl',
          },
          wslDistroOverridesByHost: {
            'host-b': 'Ubuntu',
          },
          installationMethod: 'wsl',
          wslDistroOverride: 'Ubuntu',
        },
      },
    });

    expect(settings.installationMethod).toBe('native-windows');
    expect(settings.wslDistroOverride).toBe('');
  });

  it('round-trips installationMethod and trims wslDistroOverride on update for the current host', () => {
    const settingsBag: Record<string, unknown> = {
      providerConfigs: {
        codex: {},
      },
    };

    const next = updateCodexProviderSettings(settingsBag, {
      installationMethod: 'wsl',
      wslDistroOverride: '  Ubuntu-24.04  ',
    });

    expect(next.installationMethod).toBe('wsl');
    expect(next.wslDistroOverride).toBe('Ubuntu-24.04');
    expect(getCodexProviderSettings(settingsBag)).toMatchObject({
      installationMethod: 'wsl',
      wslDistroOverride: 'Ubuntu-24.04',
      installationMethodsByHost: {
        'host-a': 'wsl',
      },
      wslDistroOverridesByHost: {
        'host-a': 'Ubuntu-24.04',
      },
    });
  });

  it('preserves another host installation settings when updating the current host', () => {
    const settingsBag: Record<string, unknown> = {
      providerConfigs: {
        codex: {
          installationMethodsByHost: {
            'host-b': 'wsl',
          },
          wslDistroOverridesByHost: {
            'host-b': 'Debian',
          },
        },
      },
    };

    const next = updateCodexProviderSettings(settingsBag, {
      installationMethod: 'native-windows',
      wslDistroOverride: '  ',
    });

    expect(next.installationMethodsByHost).toEqual({
      'host-b': 'wsl',
      'host-a': 'native-windows',
    });
    expect(next.wslDistroOverridesByHost).toEqual({
      'host-b': 'Debian',
    });
  });
});
