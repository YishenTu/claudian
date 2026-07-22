const mockGetHostnameKey = jest.fn(() => 'device:current');
const mockGetLegacyHostnameKey = jest.fn(() => 'legacy-host');

jest.mock('../../../../src/utils/env', () => ({
  ...jest.requireActual('../../../../src/utils/env'),
  getHostnameKey: () => mockGetHostnameKey(),
  getLegacyHostnameKey: () => mockGetLegacyHostnameKey(),
}));

import {
  clearCurrentGrokCatalog,
  DEFAULT_GROK_PROVIDER_SETTINGS,
  getCurrentGrokCatalog,
  getGrokProviderSettings,
  normalizeGrokCatalogSnapshot,
  updateCurrentGrokCatalog,
  updateGrokProviderSettings,
  updateGrokVisibleModels,
} from '@/providers/grok/settings';
import {
  buildGrokProviderState,
  buildPersistedGrokProviderState,
  parseGrokProviderState,
} from '@/providers/grok/types';

describe('Grok settings', () => {
  const currentCatalog = {
    defaultModelId: 'kimi-coding',
    fingerprint: 'fingerprint-current',
    models: [{
      displayName: 'Kimi Coding',
      rawId: 'kimi-coding',
      reasoningEfforts: [{ label: 'High', value: 'high' }],
      supportsReasoning: true,
    }],
    refreshedAt: 100,
  };
  const otherCatalog = {
    defaultModelId: 'glm-coding',
    fingerprint: 'fingerprint-other',
    models: [{
      displayName: 'GLM Coding',
      rawId: 'glm-coding',
      reasoningEfforts: [],
      supportsReasoning: false,
    }],
    refreshedAt: 50,
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockGetHostnameKey.mockReturnValue('device:current');
    mockGetLegacyHostnameKey.mockReturnValue('legacy-host');
  });

  it('defaults to disabled with empty environment and host state', () => {
    expect(DEFAULT_GROK_PROVIDER_SETTINGS).toEqual({
      catalogsByHost: {},
      cliPath: '',
      cliPathsByHost: {},
      enabled: false,
      environmentHash: '',
      environmentVariables: '',
      modelAliases: {},
      planBasePermissionMode: 'normal',
      preferredReasoningByModel: {},
      visibleModels: null,
    });
  });

  it('migrates legacy CLI and catalog keys to the opaque current host key', () => {
    const settings = getGrokProviderSettings({
      providerConfigs: {
        grok: {
          catalogsByHost: {
            'legacy-host': currentCatalog,
            'other-host': otherCatalog,
          },
          cliPathsByHost: {
            'legacy-host': '/legacy/grok',
            'other-host': '/other/grok',
          },
        },
      },
    });

    expect(settings.cliPathsByHost).toEqual({
      'device:current': '/legacy/grok',
      'other-host': '/other/grok',
    });
    expect(settings.catalogsByHost).toEqual({
      'device:current': currentCatalog,
      'other-host': otherCatalog,
    });
    expect(settings.currentCatalog).toEqual(currentCatalog);
  });

  it('round-trips only the current host catalog without changing other hosts', () => {
    const settings: Record<string, unknown> = {
      providerConfigs: {
        grok: {
          catalogsByHost: {
            'device:current': currentCatalog,
            'other-host': otherCatalog,
          },
        },
      },
    };
    const replacement = {
      ...currentCatalog,
      fingerprint: 'replacement',
      refreshedAt: 200,
    };

    expect(updateCurrentGrokCatalog(settings, replacement)).toEqual(replacement);
    expect(getCurrentGrokCatalog(settings)).toEqual(replacement);
    expect(getGrokProviderSettings(settings).catalogsByHost['other-host']).toEqual(otherCatalog);
    expect(clearCurrentGrokCatalog(settings)).toBe(true);
    expect(getCurrentGrokCatalog(settings)).toBeNull();
    expect(getGrokProviderSettings(settings).catalogsByHost['other-host']).toEqual(otherCatalog);
    expect(clearCurrentGrokCatalog(settings)).toBe(false);
  });

  it('whitelists catalog metadata and never persists opaque or secret fields', () => {
    const snapshot = normalizeGrokCatalogSnapshot({
      apiKey: 'catalog-secret',
      defaultModelId: 'kimi-coding',
      fingerprint: 'names-only-fingerprint',
      models: [{
        accessToken: 'model-secret',
        displayName: 'Kimi Coding',
        rawId: 'kimi-coding',
      }],
      refreshedAt: 123,
    });

    expect(snapshot).toEqual({
      defaultModelId: 'kimi-coding',
      fingerprint: 'names-only-fingerprint',
      models: [{
        displayName: 'Kimi Coding',
        rawId: 'kimi-coding',
        reasoningEfforts: [],
        supportsReasoning: false,
      }],
      refreshedAt: 123,
    });
    expect(JSON.stringify(snapshot)).not.toContain('secret');
  });

  it('normalizes catalog-scoped preferences while retaining a selected stale model', () => {
    const settings = getGrokProviderSettings({
      model: 'grok/legacy-model',
      providerConfigs: {
        grok: {
          catalogsByHost: { 'device:current': currentCatalog },
          modelAliases: {
            ' kimi-coding ': ' Kimi ',
            'legacy-model': ' Legacy ',
            unknown: 'Drop me',
          },
          preferredReasoningByModel: {
            'kimi-coding': 'medium',
            'legacy-model': 'low',
            unknown: 'xhigh',
          },
          visibleModels: [
            'kimi-coding',
            'kimi-coding',
            'legacy-model',
            'unknown',
          ],
        },
      },
    });

    expect(settings.visibleModels).toEqual(['kimi-coding', 'legacy-model']);
    expect(settings.modelAliases).toEqual({
      'kimi-coding': 'Kimi',
      'legacy-model': 'Legacy',
    });
    expect(settings.preferredReasoningByModel).toEqual({
      'kimi-coding': 'medium',
      'legacy-model': 'low',
    });
  });

  it('persists normalized settings without clobbering unrelated providers', () => {
    const settings: Record<string, unknown> = {
      providerConfigs: {
        codex: { enabled: true },
        grok: { catalogsByHost: { 'device:current': currentCatalog } },
      },
    };

    const next = updateGrokProviderSettings(settings, {
      cliPath: ' /opt/bin/grok ',
      enabled: true,
      modelAliases: { 'kimi-coding': ' Kimi ' },
      visibleModels: ['kimi-coding'],
    });

    expect(next).toMatchObject({
      cliPath: '',
      cliPathsByHost: { 'device:current': '/opt/bin/grok' },
      enabled: true,
      modelAliases: { 'kimi-coding': 'Kimi' },
      visibleModels: ['kimi-coding'],
    });
    expect((settings.providerConfigs as Record<string, unknown>).codex).toEqual({ enabled: true });
  });

  it('prunes disabled reasoning state from every host catalog', () => {
    const settings: Record<string, unknown> = {
      providerConfigs: {
        grok: {
          catalogsByHost: {
            'device:current': {
              ...currentCatalog,
              models: currentCatalog.models.map(model => ({
                ...model,
                reasoningMetadataResolved: true,
              })),
            },
            'device:other': {
              ...otherCatalog,
              models: otherCatalog.models.map(model => ({
                ...model,
                reasoningEfforts: [{ label: 'High', value: 'high' }],
                reasoningMetadataResolved: true,
                supportsReasoning: true,
              })),
            },
          },
          preferredReasoningByModel: { 'kimi-coding': 'high' },
          visibleModels: ['kimi-coding'],
        },
      },
    };

    updateGrokVisibleModels(settings, []);

    const grok = getGrokProviderSettings(settings);
    expect(grok.preferredReasoningByModel).toEqual({});
    for (const catalogSnapshot of Object.values(grok.catalogsByHost)) {
      for (const model of catalogSnapshot.models) {
        expect(model.reasoningEfforts).toEqual([]);
        expect(model.supportsReasoning).toBe(false);
        expect(model).not.toHaveProperty('reasoningMetadataResolved');
      }
    }
  });
});

describe('Grok provider state', () => {
  it('parses and builds only an absolute native session directory hint', () => {
    expect(parseGrokProviderState({
      sessionDirectory: ' /tmp/.grok/sessions/vault/session-id ',
      token: 'do-not-preserve',
    })).toEqual({
      sessionDirectory: '/tmp/.grok/sessions/vault/session-id',
    });
    expect(parseGrokProviderState({ sessionDirectory: '../outside' })).toEqual({});
    expect(buildGrokProviderState('/tmp/.grok/sessions/vault/session-id')).toEqual({
      sessionDirectory: '/tmp/.grok/sessions/vault/session-id',
    });
    expect(buildGrokProviderState('../outside')).toBeUndefined();
  });

  it('sanitizes and persists pending native fork state without unrelated fields', () => {
    expect(parseGrokProviderState({
      forkSource: { resumeAt: ' assistant-1 ', sessionId: ' source-session ' },
      forkSourceSessionDirectory: ' /tmp/.grok/sessions/vault/source-session ',
      token: 'do-not-preserve',
    })).toEqual({
      forkSource: { resumeAt: 'assistant-1', sessionId: 'source-session' },
      forkSourceSessionDirectory: '/tmp/.grok/sessions/vault/source-session',
    });
    expect(buildPersistedGrokProviderState({
      forkSource: { resumeAt: 'assistant-1', sessionId: 'source-session' },
      forkSourceSessionDirectory: '/tmp/.grok/sessions/vault/source-session',
    })).toEqual({
      forkSource: { resumeAt: 'assistant-1', sessionId: 'source-session' },
      forkSourceSessionDirectory: '/tmp/.grok/sessions/vault/source-session',
    });
    expect(parseGrokProviderState({
      forkSource: { resumeAt: '', sessionId: 'source-session' },
      forkSourceSessionDirectory: '../outside',
    })).toEqual({});
  });
});
