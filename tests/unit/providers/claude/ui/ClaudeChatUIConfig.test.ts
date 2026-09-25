import { claudeChatUIConfig } from '@/providers/claude/ui/ClaudeChatUIConfig';

describe('claudeChatUIConfig', () => {
  it('has no default until the SDK reports an enabled model', () => {
    expect(claudeChatUIConfig.getDefaultModel?.({})).toBeNull();
  });

  it('uses the selected SDK row without resolving it through environment variables', () => {
    const settings = { providerConfigs: { claude: {
      discoveredModels: [{ value: 'opus', label: 'SDK Opus', description: '', resolvedModel: 'gateway-opus' }],
      visibleModels: ['opus'], defaultModel: 'opus',
      environmentVariables: 'ANTHROPIC_DEFAULT_OPUS_MODEL=another-model',
    } } };
    expect(claudeChatUIConfig.getDefaultModel?.(settings)).toBe('opus');
    expect(claudeChatUIConfig.getModelOptions(settings)[0].label).toBe('SDK Opus');
  });

  it('uses enabled panel order instead of the retired default setting', () => {
    const config = {
      discoveredModels: ['opus', 'sonnet'].map(value => ({ value, label: value, description: '' })),
      visibleModels: ['sonnet', 'opus'], defaultModel: 'opus',
    };
    const settings = { providerConfigs: { claude: config } };
    expect(claudeChatUIConfig.getDefaultModel?.(settings)).toBe('sonnet');
    config.visibleModels = ['opus', 'sonnet'];
    expect(claudeChatUIConfig.getDefaultModel?.(settings)).toBe('opus');
    config.visibleModels = [];
    expect(claudeChatUIConfig.getDefaultModel?.(settings)).toBeNull();
  });

  it('never normalizes a deselected SDK variant to its enabled sibling', () => {
    const settings = { providerConfigs: { claude: {
      discoveredModels: ['sonnet', 'sonnet[1m]'].map(value => ({ value, label: value, resolvedModel: 'same-model' })),
      visibleModels: ['sonnet[1m]'],
    } } };
    expect(claudeChatUIConfig.normalizeAvailableModelSelection?.('sonnet', settings)).toBe('sonnet');
    expect(claudeChatUIConfig.getModelOptions(settings).map(row => row.value)).toEqual(['claude-code/sonnet[1m]']);
  });

  describe('reported effort capabilities', () => {
    const settingsWith = (
      models: Array<{ value: string; resolvedModel?: string; supportedEffortLevels?: string[] }>,
      extra: Record<string, unknown> = {},
    ): Record<string, unknown> => ({
      ...extra,
      providerConfigs: { claude: {
        discoveredModels: models.map(model => ({ label: model.value, description: '', ...model })),
        visibleModels: models.map(model => model.value),
      } },
    });

    it('lists exactly the reported levels for the selected model', () => {
      const settings = settingsWith([
        { value: 'opus', supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] },
        { value: 'haiku', supportedEffortLevels: ['low', 'high'] },
      ]);

      expect(claudeChatUIConfig.getReasoningOptions('opus', settings).map(option => option.value))
        .toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
      expect(claudeChatUIConfig.getReasoningOptions('haiku', settings).map(option => option.value))
        .toEqual(['low', 'high']);
      expect(claudeChatUIConfig.getReasoningOptions('opus', settings)
        .find(option => option.value === 'xhigh')?.label).toBe('xHigh');
    });

    it('returns no options when metadata is missing or empty, regardless of model name', () => {
      const settings = settingsWith([
        { value: 'opus' },
        { value: 'claude-opus-4-7', supportedEffortLevels: [] },
      ]);

      expect(claudeChatUIConfig.getReasoningOptions('opus', settings)).toEqual([]);
      expect(claudeChatUIConfig.getReasoningOptions('claude-opus-4-7', settings)).toEqual([]);
      expect(claudeChatUIConfig.getReasoningOptions('fable', {})).toEqual([]);
    });

    it('matches capabilities through an unambiguous resolved model', () => {
      const settings = settingsWith([
        { value: 'opus', resolvedModel: 'claude-opus-5', supportedEffortLevels: ['low', 'max'] },
      ]);

      expect(claudeChatUIConfig.getReasoningOptions('claude-opus-5', settings).map(option => option.value))
        .toEqual(['low', 'max']);
    });

    it('does not merge distinct normal and [1m] selections', () => {
      const settings = settingsWith([
        { value: 'sonnet', supportedEffortLevels: ['low', 'high'] },
        { value: 'sonnet[1m]' },
      ]);

      expect(claudeChatUIConfig.getReasoningOptions('sonnet[1m]', settings)).toEqual([]);
    });

    it('defaults to High without selecting another native effort', () => {
      expect(claudeChatUIConfig.getDefaultReasoningValue('opus', settingsWith([
        { value: 'opus', supportedEffortLevels: ['low', 'high', 'max'] },
      ]))).toBe('high');
      expect(claudeChatUIConfig.getDefaultReasoningValue('opus', settingsWith([
        { value: 'opus', supportedEffortLevels: ['medium', 'max'] },
      ]))).toBe('high');
    });

    it('keeps a supported saved choice and normalizes an unsupported one', () => {
      const supported = settingsWith([
        { value: 'opus', supportedEffortLevels: ['low', 'high', 'xhigh'] },
      ], { effortLevel: 'xhigh' });
      claudeChatUIConfig.applyModelDefaults('opus', supported);
      expect(supported.effortLevel).toBe('xhigh');

      const unsupported = settingsWith([
        { value: 'haiku', supportedEffortLevels: ['low', 'high'] },
      ], { effortLevel: 'xhigh' });
      claudeChatUIConfig.applyModelProjectionDefaults?.('haiku', unsupported);
      expect(unsupported.effortLevel).toBe('high');

      const withoutHigh = settingsWith([
        { value: 'haiku', supportedEffortLevels: ['low', 'medium'] },
      ], { effortLevel: 'max' });
      claudeChatUIConfig.applyModelDefaults('haiku', withoutHigh);
      expect(withoutHigh.effortLevel).toBe('high');
    });

    it('preserves the saved preference while metadata is unavailable', () => {
      const settings = settingsWith([{ value: 'opus' }], { effortLevel: 'xhigh' });

      claudeChatUIConfig.applyModelDefaults('opus', settings);
      expect(settings.effortLevel).toBe('xhigh');
      claudeChatUIConfig.applyModelProjectionDefaults?.('opus', settings);
      expect(settings.effortLevel).toBe('xhigh');
      expect(claudeChatUIConfig.getDefaultReasoningValue('opus', settings)).toBe('xhigh');
    });
  });
});
