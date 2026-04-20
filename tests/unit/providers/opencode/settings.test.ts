jest.mock('../../../../src/utils/env', () => ({
  ...jest.requireActual('../../../../src/utils/env'),
  getHostnameKey: () => 'host-a',
}));

import {
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
});
