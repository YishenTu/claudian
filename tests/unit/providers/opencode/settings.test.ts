import {
  getOpencodeProviderSettings,
  normalizeOpencodePreferredThinkingByModel,
  normalizeOpencodeVisibleModels,
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
      visibleModels: [
        'anthropic/claude-sonnet-4',
        'google/gemini-2.5-pro',
      ],
    });
  });
});
