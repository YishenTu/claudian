import { BUILT_IN_PROVIDER_MODULES } from '@/providers';
import { getCodexProviderSettings } from '@/providers/codex/settings';
import { getBuiltInProviderDefaultConfigs } from '@/providers/defaultProviderConfigs';

function getProviderConfig(
  settings: Record<string, unknown>,
  providerId: string,
): Record<string, unknown> {
  const providerConfigs = settings.providerConfigs as Record<string, unknown>;
  return providerConfigs[providerId] as Record<string, unknown>;
}

describe('built-in ProviderModule catalog', () => {
  it('is the single ordered source for chat, workspace, and settings composition', () => {
    expect(BUILT_IN_PROVIDER_MODULES.map(module => module.id)).toEqual([
      'claude',
      'codex',
      'grok',
      'opencode',
      'pi',
    ]);
    for (const module of BUILT_IN_PROVIDER_MODULES) {
      expect(module.workspace.initialize).toEqual(expect.any(Function));
      expect(module.settingsStorage.normalizeStored).toEqual(expect.any(Function));
    }
  });

  it('runtime-decodes malformed persisted scalar settings for every provider', () => {
    const malformedSettings: Record<string, unknown> = {
      providerConfigs: Object.fromEntries(BUILT_IN_PROVIDER_MODULES.map(module => [
        module.id,
        {
          cliPath: 7,
          enabled: 'false',
          environmentHash: false,
          environmentVariables: ['SECRET=not-a-string'],
        },
      ])),
    };
    Object.assign(getProviderConfig(malformedSettings, 'claude'), {
      customModels: {},
      defaultModel: {},
      enableBangBash: 1,
      enableChrome: 'true',
      lastModel: [],
      loadUserSettings: 'false',
      safeMode: 'unknown',
    });
    Object.assign(getProviderConfig(malformedSettings, 'codex'), {
      catalogFingerprint: [],
      catalogTimestamp: 'now',
      customModels: {},
      reasoningSummary: 'verbose',
      safeMode: 'danger-full-access',
    });
    Object.assign(getProviderConfig(malformedSettings, 'opencode'), {
      selectedMode: 123,
    });
    Object.assign(getProviderConfig(malformedSettings, 'pi'), {
      toolMode: 'danger-full-access',
    });

    const defaultEnabled: Record<string, boolean> = {
      claude: true,
      codex: false,
      grok: false,
      opencode: false,
      pi: false,
    };

    for (const module of BUILT_IN_PROVIDER_MODULES) {
      expect(module.isEnabled(malformedSettings)).toBe(defaultEnabled[module.id]);
    }
    expect(getCodexProviderSettings(malformedSettings).safeMode).toBe('read-only');

    const normalizedSettings: Record<string, unknown> = {};
    for (const module of BUILT_IN_PROVIDER_MODULES) {
      expect(module.settingsStorage.normalizeStored(
        normalizedSettings,
        malformedSettings,
      )).toBe(true);
      const config = getProviderConfig(normalizedSettings, module.id);
      expect(config.enabled).toBe(defaultEnabled[module.id]);
      expect(config.cliPath).toEqual(expect.any(String));
      expect(config.environmentHash).toEqual(expect.any(String));
      expect(config.environmentVariables).toEqual(expect.any(String));
    }

    expect(getProviderConfig(normalizedSettings, 'claude')).toMatchObject({
      customModels: expect.any(String),
      defaultModel: expect.any(String),
      enableBangBash: false,
      enableChrome: false,
      lastModel: expect.any(String),
      loadUserSettings: true,
      safeMode: 'default',
    });
    expect(getProviderConfig(normalizedSettings, 'codex')).toMatchObject({
      catalogFingerprint: expect.any(String),
      catalogTimestamp: 0,
      customModels: expect.any(String),
      reasoningSummary: 'detailed',
      safeMode: 'read-only',
    });
    expect(getProviderConfig(normalizedSettings, 'opencode')).toMatchObject({
      selectedMode: 'claudian-safe',
    });
    expect(getProviderConfig(normalizedSettings, 'pi')).toMatchObject({
      toolMode: 'readonly',
    });
  });

  it('keeps ephemeral OpenCode plan-mode normalization provider-owned', () => {
    const opencodeModule = BUILT_IN_PROVIDER_MODULES.find(module => module.id === 'opencode');
    const normalizedSettings: Record<string, unknown> = {};

    expect(opencodeModule?.settingsStorage.normalizeStored(normalizedSettings, {
      providerConfigs: {
        opencode: {
          selectedMode: 'plan',
        },
      },
    })).toBe(true);
    expect(getProviderConfig(normalizedSettings, 'opencode').selectedMode).toBe('claudian-safe');
  });

  it('does not report canonical provider defaults as changed', () => {
    const storedSettings = {
      providerConfigs: getBuiltInProviderDefaultConfigs(),
    };
    const normalizedSettings: Record<string, unknown> = {};

    for (const module of BUILT_IN_PROVIDER_MODULES) {
      expect(module.settingsStorage.normalizeStored(
        normalizedSettings,
        storedSettings,
      )).toBe(false);
    }
  });
});
