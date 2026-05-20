const mockGetHostnameKey = jest.fn(() => 'host-a');
const mockGetLegacyHostnameKey = jest.fn(() => 'legacy-host');

jest.mock('../../../../src/utils/env', () => ({
  ...jest.requireActual('../../../../src/utils/env'),
  getHostnameKey: () => mockGetHostnameKey(),
  getLegacyHostnameKey: () => mockGetLegacyHostnameKey(),
}));

import {
  DEFAULT_OPENCODE_PROVIDER_SETTINGS,
  getOpencodeProviderSettings,
  normalizeOpencodeModelAliases,
  normalizeOpencodePreferredThinkingByModel,
  normalizeOpencodeVisibleModels,
  updateOpencodeProviderSettings,
} from '../../../../src/providers/opencode/settings';

describe('OpenCode settings normalization', () => {
  const discoveredModels = [
    { label: 'Anthropic/Claude Sonnet 4', rawId: 'anthropic/claude-sonnet-4' },
    { label: 'Anthropic/Claude Sonnet 4 (high)', rawId: 'anthropic/claude-sonnet-4/high' },
    { label: 'Google/Gemini 2.5 Pro', rawId: 'google/gemini-2.5-pro' },
  ];

  beforeEach(() => {
    jest.clearAllMocks();
    mockGetHostnameKey.mockReturnValue('host-a');
    mockGetLegacyHostnameKey.mockReturnValue('legacy-host');
  });

  it('enables Exa-backed web search in the default provider env', () => {
    expect(DEFAULT_OPENCODE_PROVIDER_SETTINGS.environmentVariables).toBe('OPENCODE_ENABLE_EXA=1');
  });

  it('normalizes visible models to base model ids', () => {
    expect(normalizeOpencodeVisibleModels([
      'anthropic/claude-sonnet-4/high',
      'anthropic/claude-sonnet-4',
      'google/gemini-2.5-pro',
    ], discoveredModels)).toEqual([
      'anthropic/claude-sonnet-4',
      'google/gemini-2.5-pro',
    ]);
  });

  it('normalizes preferred thinking keys to base model ids', () => {
    expect(normalizeOpencodePreferredThinkingByModel({
      'anthropic/claude-sonnet-4/high': 'high',
      'google/gemini-2.5-pro': 'max',
    }, discoveredModels)).toEqual({
      'anthropic/claude-sonnet-4': 'high',
      'google/gemini-2.5-pro': 'max',
    });
  });

  it('hydrates provider settings with normalized base models and preferred thinking', () => {
    expect(getOpencodeProviderSettings({
      providerConfigs: {
        opencode: {
          cliPath: '/legacy/opencode',
          cliPathsByHost: {
            'host-a': '/host-a/opencode',
            'host-b': '/host-b/opencode',
          },
          discoveredModels,
          preferredThinkingByModel: {
            'anthropic/claude-sonnet-4/high': 'high',
          },
          visibleModels: [
            'anthropic/claude-sonnet-4/high',
            'google/gemini-2.5-pro',
          ],
        },
      },
    })).toMatchObject({
      preferredThinkingByModel: {
        'anthropic/claude-sonnet-4': 'high',
      },
      cliPath: '/legacy/opencode',
      cliPathsByHost: {
        'host-a': '/host-a/opencode',
        'host-b': '/host-b/opencode',
      },
      visibleModels: [
        'anthropic/claude-sonnet-4',
        'google/gemini-2.5-pro',
      ],
    });
  });

  it('migrates current legacy hostname-scoped CLI paths to the opaque device key', () => {
    mockGetHostnameKey.mockReturnValue('device:current');
    mockGetLegacyHostnameKey.mockReturnValue('host-a');

    const settings = getOpencodeProviderSettings({
      providerConfigs: {
        opencode: {
          cliPathsByHost: {
            'host-a': '/host-a/opencode',
            'host-b': '/host-b/opencode',
          },
        },
      },
    });

    expect(settings.cliPathsByHost).toEqual({
      'device:current': '/host-a/opencode',
      'host-b': '/host-b/opencode',
    });
  });

  it('normalizes model aliases to base model ids and trims values', () => {
    expect(normalizeOpencodeModelAliases({
      'anthropic/claude-sonnet-4/high': '  Sonnet  ',
      'google/gemini-2.5-pro': 'Gemini Pro',
      'unknown/model': 'ignored',
      'anthropic/claude-sonnet-4': '',
    }, discoveredModels)).toEqual({
      'anthropic/claude-sonnet-4': 'Sonnet',
      'google/gemini-2.5-pro': 'Gemini Pro',
      'unknown/model': 'ignored',
    });
  });

  it('ignores non-string and non-object alias payloads', () => {
    expect(normalizeOpencodeModelAliases(null, discoveredModels)).toEqual({});
    expect(normalizeOpencodeModelAliases(['alias'], discoveredModels)).toEqual({});
    expect(normalizeOpencodeModelAliases({ 'anthropic/claude-sonnet-4': 123 }, discoveredModels)).toEqual({});
  });

  it('prunes aliases whose rawId is no longer visible when updating settings', () => {
    const settings: Record<string, unknown> = {
      providerConfigs: {
        opencode: {
          discoveredModels,
          modelAliases: {
            'anthropic/claude-sonnet-4': 'Sonnet',
            'google/gemini-2.5-pro': 'Gemini',
          },
          visibleModels: [
            'anthropic/claude-sonnet-4',
            'google/gemini-2.5-pro',
          ],
        },
      },
    };

    const next = updateOpencodeProviderSettings(settings, {
      visibleModels: ['anthropic/claude-sonnet-4'],
    });

    expect(next.visibleModels).toEqual(['anthropic/claude-sonnet-4']);
    expect(next.modelAliases).toEqual({ 'anthropic/claude-sonnet-4': 'Sonnet' });
    expect((settings.providerConfigs as Record<string, any>).opencode.discoveredModels).toBeUndefined();
  });

  it('falls back active and saved OpenCode selections when the current model is removed from visible models', () => {
    const settings: Record<string, unknown> = {
      effortLevel: 'high',
      model: 'opencode:google/gemini-2.5-pro',
      providerConfigs: {
        opencode: {
          discoveredModels: [
            ...discoveredModels,
            { label: 'OpenAI/GPT-5', rawId: 'openai/gpt-5' },
            { label: 'OpenAI/GPT-5 (high)', rawId: 'openai/gpt-5/high' },
          ],
          preferredThinkingByModel: {
            'openai/gpt-5': 'high',
          },
          visibleModels: [
            'google/gemini-2.5-pro',
            'openai/gpt-5',
          ],
        },
      },
      savedProviderEffort: {
        opencode: 'high',
      },
      savedProviderModel: {
        opencode: 'opencode:google/gemini-2.5-pro',
      },
      titleGenerationModel: 'opencode:google/gemini-2.5-pro',
    };

    const next = updateOpencodeProviderSettings(settings, {
      visibleModels: ['openai/gpt-5'],
    });

    expect(next.visibleModels).toEqual(['openai/gpt-5']);
    expect(settings.model).toBe('opencode:openai/gpt-5');
    expect(settings.effortLevel).toBe('high');
    expect((settings.savedProviderModel as Record<string, string>).opencode).toBe('opencode:openai/gpt-5');
    expect((settings.savedProviderEffort as Record<string, string>).opencode).toBe('high');
    expect(settings.titleGenerationModel).toBe('opencode:openai/gpt-5');
  });

  it('clears the OpenCode title model when all visible models are removed', () => {
    const settings: Record<string, unknown> = {
      providerConfigs: {
        opencode: {
          discoveredModels,
          visibleModels: ['google/gemini-2.5-pro'],
        },
      },
      titleGenerationModel: 'opencode:google/gemini-2.5-pro',
    };

    const next = updateOpencodeProviderSettings(settings, {
      visibleModels: [],
    });

    expect(next.visibleModels).toEqual([]);
    expect(settings.titleGenerationModel).toBe('');
  });

  it('keeps runtime discovery in memory when updating provider settings', () => {
    const settings: Record<string, unknown> = {
      providerConfigs: {
        opencode: {
          availableModes: [
            { id: 'build', name: 'Build' },
          ],
          discoveredModels,
          visibleModels: ['anthropic/claude-sonnet-4'],
        },
      },
    };

    const next = updateOpencodeProviderSettings(settings, {
      availableModes: [
        { id: 'build', name: 'Build' },
        { id: 'plan', name: 'Plan' },
      ],
      discoveredModels: [
        ...discoveredModels,
        { label: 'OpenAI/GPT-5', rawId: 'openai/gpt-5' },
      ],
    });

    expect(next.availableModes).toEqual([
      { id: 'build', name: 'Build' },
      { id: 'plan', name: 'Plan' },
    ]);
    expect(next.discoveredModels).toEqual([
      ...discoveredModels,
      { label: 'OpenAI/GPT-5', rawId: 'openai/gpt-5' },
    ]);
    expect((settings.providerConfigs as Record<string, any>).opencode.availableModes).toBeUndefined();
    expect((settings.providerConfigs as Record<string, any>).opencode.discoveredModels).toBeUndefined();
  });

  it('persists thinking options only for visible or selected OpenCode models', () => {
    const settings: Record<string, unknown> = {
      model: 'opencode:google/gemini-2.5-pro',
      providerConfigs: {
        opencode: {
          discoveredModels,
          visibleModels: ['anthropic/claude-sonnet-4'],
        },
      },
      savedProviderModel: {
        opencode: 'opencode:google/gemini-2.5-pro',
      },
    };

    const next = updateOpencodeProviderSettings(settings, {
      thinkingOptionsByModel: {
        'anthropic/claude-sonnet-4': [
          { label: 'High', value: 'high' },
        ],
        'google/gemini-2.5-pro': [
          { label: 'Low', value: 'low' },
        ],
        'openai/gpt-5': [
          { label: 'Max', value: 'max' },
        ],
      },
    });

    expect(next.thinkingOptionsByModel).toMatchObject({
      'anthropic/claude-sonnet-4': [
        { label: 'High', value: 'high' },
      ],
      'google/gemini-2.5-pro': [
        { label: 'Low', value: 'low' },
      ],
    });
    expect((settings.providerConfigs as Record<string, any>).opencode.thinkingOptionsByModel).toEqual({
      'anthropic/claude-sonnet-4': [
        { label: 'High', value: 'high' },
      ],
      'google/gemini-2.5-pro': [
        { label: 'Low', value: 'low' },
      ],
    });
    expect((settings.providerConfigs as Record<string, any>).opencode.discoveredModels).toBeUndefined();
  });

  it('hydrates persisted thinking options without requiring the full discovered model catalog', () => {
    const settings = getOpencodeProviderSettings({
      providerConfigs: {
        opencode: {
          thinkingOptionsByModel: {
            'deepseek/deepseek-v4-pro': [
              { label: 'Low', value: 'low' },
              { label: 'Max', value: 'max' },
            ],
          },
          visibleModels: ['deepseek/deepseek-v4-pro'],
        },
      },
    });

    expect(settings.discoveredModels).toEqual([]);
    expect(settings.thinkingOptionsByModel).toEqual({
      'deepseek/deepseek-v4-pro': [
        { label: 'Low', value: 'low' },
        { label: 'Max', value: 'max' },
      ],
    });
  });

  it('preserves persisted thinking options when unrelated provider settings are updated', () => {
    const settings: Record<string, unknown> = {
      providerConfigs: {
        opencode: {
          environmentHash: '',
          thinkingOptionsByModel: {
            'deepseek/deepseek-v4-pro': [
              { label: 'Low', value: 'low' },
              { label: 'Max', value: 'max' },
            ],
          },
          visibleModels: ['deepseek/deepseek-v4-pro'],
        },
      },
    };

    updateOpencodeProviderSettings(settings, {
      environmentHash: 'OPENCODE_DB=/tmp/opencode.db',
    });

    expect((settings.providerConfigs as Record<string, any>).opencode.thinkingOptionsByModel).toEqual({
      'deepseek/deepseek-v4-pro': [
        { label: 'Low', value: 'low' },
        { label: 'Max', value: 'max' },
      ],
    });
  });

  it('normalizes saved custom OpenCode modes back to the managed YOLO mode', () => {
    expect(getOpencodeProviderSettings({
      providerConfigs: {
        opencode: {
          availableModes: [],
          selectedMode: 'compaction',
        },
      },
    }).selectedMode).toBe('claudian-yolo');
  });

  it('normalizes the legacy build alias back to the managed YOLO mode', () => {
    expect(getOpencodeProviderSettings({
      providerConfigs: {
        opencode: {
          availableModes: [],
          selectedMode: 'build',
        },
      },
    }).selectedMode).toBe('claudian-yolo');
  });

  it('preserves legacy cliPath when no host-scoped path exists', () => {
    expect(getOpencodeProviderSettings({
      providerConfigs: {
        opencode: {
          cliPath: '/legacy/opencode',
          cliPathsByHost: {
            'host-b': '/other-host/opencode',
          },
        },
      },
    })).toMatchObject({
      cliPath: '/legacy/opencode',
      cliPathsByHost: {
        'host-b': '/other-host/opencode',
      },
    });
  });

  it('writes host-scoped cli paths when updating provider settings', () => {
    const settings: Record<string, unknown> = {
      providerConfigs: {
        opencode: {
          cliPath: '/legacy/opencode',
        },
      },
    };

    const next = updateOpencodeProviderSettings(settings, {
      cliPathsByHost: {
        'host-a': '/custom/opencode',
      },
    });

    expect(next.cliPathsByHost).toEqual({
      'host-a': '/custom/opencode',
    });
    expect((settings.providerConfigs as Record<string, any>).opencode.cliPathsByHost).toEqual({
      'host-a': '/custom/opencode',
    });
  });

  it('preserves legacy cliPath when applying a full settings snapshot', () => {
    const settings: Record<string, unknown> = {
      providerConfigs: {
        opencode: {
          cliPath: '/legacy/opencode',
          cliPathsByHost: {
            'host-b': '/other-host/opencode',
          },
        },
      },
    };

    const snapshot = getOpencodeProviderSettings(settings);
    const next = updateOpencodeProviderSettings(settings, snapshot);

    expect(next.cliPath).toBe('/legacy/opencode');
    expect((settings.providerConfigs as Record<string, any>).opencode).toMatchObject({
      cliPath: '/legacy/opencode',
      cliPathsByHost: {
        'host-b': '/other-host/opencode',
      },
    });
  });

  it('drops the legacy cliPath once host-scoped paths are explicitly edited', () => {
    const settings: Record<string, unknown> = {
      providerConfigs: {
        opencode: {
          cliPath: '/legacy/opencode',
        },
      },
    };

    const next = updateOpencodeProviderSettings(settings, {
      cliPathsByHost: {
        'host-a': '/custom/opencode',
      },
    });

    expect(next.cliPath).toBe('');
    expect((settings.providerConfigs as Record<string, any>).opencode.cliPath).toBe('');

    const cleared = updateOpencodeProviderSettings(settings, {
      cliPathsByHost: {},
    });

    expect(cleared.cliPath).toBe('');
    expect(cleared.cliPathsByHost).toEqual({});
    expect((settings.providerConfigs as Record<string, any>).opencode).toMatchObject({
      cliPath: '',
      cliPathsByHost: {},
    });
  });
});
