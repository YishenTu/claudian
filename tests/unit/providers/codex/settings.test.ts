import { CODEX_SPARK_MODEL, TEST_CODEX_CATALOG } from '@test/helpers/codexModels';

import {
  applyCodexModelDefaults,
  createCodexVisibleModelFilter,
  DEFAULT_CODEX_PROVIDER_SETTINGS,
  getCodexProviderSettings,
  getEffectiveCodexReasoningSummary,
  getVisibleCodexModelIds,
  normalizeCodexModelAliases,
  normalizeCodexStoredConfig,
  normalizeCodexVisibleModels,
  updateCodexProviderSettings,
} from '@/providers/codex/settings';

const mockGetHostnameKey = jest.fn(() => 'host-a');
const mockGetLegacyHostnameKey = jest.fn(() => 'legacy-host');
const originalPlatform = process.platform;

jest.mock('@/utils/env', () => ({
  ...jest.requireActual('@/utils/env'),
  getHostnameKey: () => mockGetHostnameKey(),
  getLegacyHostnameKey: () => mockGetLegacyHostnameKey(),
}));

describe('codex settings', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetHostnameKey.mockReturnValue('host-a');
    mockGetLegacyHostnameKey.mockReturnValue('legacy-host');
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform });
  });

  it('defaults installationMethod to native-windows and leaves wslDistroOverride empty', () => {
    const settings = getCodexProviderSettings({});

    expect(settings.customModels).toBe('');
    expect(settings.modelAliases).toEqual({});
    expect(settings.visibleModels).toBeNull();
    expect(settings.installationMethod).toBe('native-windows');
    expect(settings.wslDistroOverride).toBe('');
    expect(settings.installationMethod).toBe(DEFAULT_CODEX_PROVIDER_SETTINGS.installationMethod);
    expect(settings.wslDistroOverride).toBe(DEFAULT_CODEX_PROVIDER_SETTINGS.wslDistroOverride);
  });

  it('treats a null visibility filter as all discovered models', () => {
    const discoveredModels = [
      { model: 'gpt-5.5' },
      { model: 'gpt-5.4-mini' },
    ] as any;

    expect(getVisibleCodexModelIds(null, discoveredModels)).toEqual([
      'gpt-5.5',
      'gpt-5.4-mini',
    ]);
  });

  it('normalizes an explicit visibility filter against the discovered catalog', () => {
    const discoveredModels = [
      { model: 'gpt-5.5' },
      { model: 'gpt-5.4-mini' },
    ] as any;

    expect(normalizeCodexVisibleModels(
      [' gpt-5.4-mini ', 'missing-model', 'gpt-5.4-mini', 42],
      discoveredModels,
    )).toEqual(['gpt-5.4-mini']);
    expect(normalizeCodexVisibleModels(undefined, discoveredModels)).toBeNull();
    expect(createCodexVisibleModelFilter(
      ['gpt-5.5', 'gpt-5.4-mini'],
      discoveredModels,
    )).toBeNull();
  });

  it('normalizes model aliases against the discovered catalog', () => {
    expect(normalizeCodexModelAliases({
      ' gpt-5.5 ': '  Primary  ',
      'gpt-5.4-mini': ' ',
      missing: 'Missing',
      invalid: 42,
    }, TEST_CODEX_CATALOG as any)).toEqual({
      'gpt-5.5': 'Primary',
    });
  });

  it('persists aliases only for visible models', () => {
    const settingsBag: Record<string, unknown> = {
      providerConfigs: {
        codex: {
          discoveredModels: TEST_CODEX_CATALOG,
          visibleModels: null,
        },
      },
    };

    updateCodexProviderSettings(settingsBag, {
      modelAliases: {
        'gpt-5.4-mini': 'Mini',
        'gpt-5.5': 'Primary',
      },
    });
    updateCodexProviderSettings(settingsBag, { visibleModels: ['gpt-5.5'] });

    expect(getCodexProviderSettings(settingsBag).modelAliases).toEqual({
      'gpt-5.5': 'Primary',
    });
  });

  it('normalizes and persists the app-server model catalog', () => {
    const settingsBag: Record<string, unknown> = {
      providerConfigs: {
        codex: {
          discoveredModels: [{
            id: 'gpt-5.6-sol',
            model: 'gpt-5.6-sol',
            displayName: 'GPT-5.6-Sol',
            description: 'Latest frontier agentic coding model.',
            hidden: false,
            supportedReasoningEfforts: [
              { reasoningEffort: 'low', description: 'Fast' },
              { reasoningEffort: 'ultra', description: 'Automatic task delegation' },
            ],
            defaultReasoningEffort: 'low',
            serviceTiers: [{ id: 'priority', name: 'Fast', description: '1.5x speed' }],
            defaultServiceTier: null,
            inputModalities: ['text', 'image'],
            isDefault: true,
          }],
        },
      },
    };

    const discoveredModels = getCodexProviderSettings(settingsBag).discoveredModels;
    expect(discoveredModels[0]).toMatchObject({
      model: 'gpt-5.6-sol',
      defaultReasoningEffort: 'low',
      supportedReasoningEfforts: [
        { value: 'low', description: 'Fast' },
      ],
    });

    updateCodexProviderSettings(settingsBag, { discoveredModels });
    expect(settingsBag).toMatchObject({
      providerConfigs: {
        codex: {
          discoveredModels,
        },
      },
    });
  });

  it('retargets global Codex projections when their discovered model is hidden', () => {
    const settingsBag: Record<string, unknown> = {
      settingsProvider: 'codex',
      model: 'gpt-5.5',
      effortLevel: 'high',
      serviceTier: 'priority',
      titleGenerationModel: 'gpt-5.5',
      savedProviderModel: { codex: 'gpt-5.5' },
      savedProviderEffort: { codex: 'high' },
      savedProviderServiceTier: { codex: 'priority' },
      providerConfigs: {
        codex: {
          discoveredModels: TEST_CODEX_CATALOG,
          visibleModels: null,
        },
      },
    };

    updateCodexProviderSettings(settingsBag, { visibleModels: ['gpt-5.4-mini'] });

    expect(settingsBag).toMatchObject({
      model: 'gpt-5.4-mini',
      effortLevel: 'medium',
      serviceTier: 'default',
      titleGenerationModel: 'gpt-5.4-mini',
      savedProviderModel: { codex: 'gpt-5.4-mini' },
      savedProviderEffort: { codex: 'medium' },
      savedProviderServiceTier: { codex: 'default' },
    });
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

  it('migrates current legacy hostname-scoped settings to the opaque device key', () => {
    mockGetHostnameKey.mockReturnValue('device:current');
    mockGetLegacyHostnameKey.mockReturnValue('host-a');

    const settings = getCodexProviderSettings({
      providerConfigs: {
        codex: {
          cliPathsByHost: {
            'host-a': '/host-a/codex',
            'host-b': '/host-b/codex',
          },
          installationMethodsByHost: {
            'host-a': 'wsl',
            'host-b': 'native-windows',
          },
          wslDistroOverridesByHost: {
            'host-a': 'Ubuntu',
            'host-b': 'Debian',
          },
        },
      },
    });

    expect(settings.cliPathsByHost).toEqual({
      'device:current': '/host-a/codex',
      'host-b': '/host-b/codex',
    });
    expect(settings.installationMethod).toBe('wsl');
    expect(settings.installationMethodsByHost).toEqual({
      'device:current': 'wsl',
      'host-b': 'native-windows',
    });
    expect(settings.wslDistroOverride).toBe('Ubuntu');
    expect(settings.wslDistroOverridesByHost).toEqual({
      'device:current': 'Ubuntu',
      'host-b': 'Debian',
    });
  });

  it('round-trips installationMethod and trims wslDistroOverride on update for the current host', () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
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
    Object.defineProperty(process, 'platform', { value: 'win32' });
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

  it('does not persist Windows installation settings on non-Windows hosts', () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    const settingsBag: Record<string, unknown> = {
      providerConfigs: {
        codex: {
          installationMethodsByHost: {
            'host-a': 'wsl',
            'host-b': 'wsl',
          },
          wslDistroOverridesByHost: {
            'host-a': 'Ubuntu-24.04',
            'host-b': 'Debian',
          },
        },
      },
    };

    const next = updateCodexProviderSettings(
      settingsBag,
      getCodexProviderSettings(settingsBag),
    );

    expect(next.installationMethod).toBe(DEFAULT_CODEX_PROVIDER_SETTINGS.installationMethod);
    expect(next.installationMethodsByHost).toEqual({
      'host-b': 'wsl',
    });
    expect(next.wslDistroOverride).toBe(DEFAULT_CODEX_PROVIDER_SETTINGS.wslDistroOverride);
    expect(next.wslDistroOverridesByHost).toEqual({
      'host-b': 'Debian',
    });
    expect(getCodexProviderSettings(settingsBag).installationMethodsByHost).toEqual({
      'host-b': 'wsl',
    });
    expect(getCodexProviderSettings(settingsBag).wslDistroOverridesByHost).toEqual({
      'host-b': 'Debian',
    });
  });

  it('normalizes stored Codex config without treating effective defaults as persisted fields', () => {
    const result = normalizeCodexStoredConfig(
      {
        providerConfigs: {
          codex: {
            enabled: true,
            installationMethod: 'native-windows',
            wslDistroOverride: '',
            installationMethodsByHost: {
              'host-a': 'wsl',
              'host-b': 'wsl',
            },
            wslDistroOverridesByHost: {
              'host-a': 'Ubuntu-24.04',
              'host-b': 'Debian',
            },
          },
        },
      },
      {
        platform: 'darwin',
        hostnameKey: 'host-a',
        legacyHostnameKey: 'legacy-host',
      },
    );

    expect(result.changed).toBe(true);
    expect(result.config).toMatchObject({
      enabled: true,
      installationMethodsByHost: {
        'host-b': 'wsl',
      },
      wslDistroOverridesByHost: {
        'host-b': 'Debian',
      },
    });
    expect(result.config).not.toHaveProperty('installationMethod');
    expect(result.config).not.toHaveProperty('wslDistroOverride');
  });

  it('migrates legacy Windows Codex installation scalars into current host maps', () => {
    const result = normalizeCodexStoredConfig(
      {
        providerConfigs: {
          codex: {
            installationMethod: 'wsl',
            wslDistroOverride: ' Ubuntu ',
          },
        },
      },
      {
        platform: 'win32',
        hostnameKey: 'host-a',
        legacyHostnameKey: 'legacy-host',
      },
    );

    expect(result.changed).toBe(true);
    expect(result.config.installationMethodsByHost).toEqual({
      'host-a': 'wsl',
    });
    expect(result.config.wslDistroOverridesByHost).toEqual({
      'host-a': 'Ubuntu',
    });
    expect(result.config).not.toHaveProperty('installationMethod');
    expect(result.config).not.toHaveProperty('wslDistroOverride');
  });

  it('forces reasoning summary off for GPT-5.3 Codex Spark', () => {
    const settingsBag: Record<string, unknown> = {
      providerConfigs: {
        codex: {
          reasoningSummary: 'detailed',
        },
      },
    };

    expect(getEffectiveCodexReasoningSummary(settingsBag, CODEX_SPARK_MODEL)).toBe('none');
    expect(getEffectiveCodexReasoningSummary(settingsBag, 'gpt-5.5')).toBe('detailed');
  });

  it('sets reasoning summary off when applying GPT-5.3 Codex Spark model defaults', () => {
    const settingsBag: Record<string, unknown> = {
      providerConfigs: {
        codex: {
          reasoningSummary: 'detailed',
        },
      },
    };

    applyCodexModelDefaults(CODEX_SPARK_MODEL, settingsBag);

    expect(getCodexProviderSettings(settingsBag).reasoningSummary).toBe('none');
  });
});
