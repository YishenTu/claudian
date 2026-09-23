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

  it('defaults Claude models to high effort', () => {
    expect(claudeChatUIConfig.getDefaultReasoningValue('haiku', {})).toBe('high');
    expect(claudeChatUIConfig.getDefaultReasoningValue('custom-model', {})).toBe('high');
  });

  describe('getReasoningOptions', () => {
    it('hides xhigh on models that do not support it', () => {
      const options = claudeChatUIConfig.getReasoningOptions('claude-sonnet-4-5', {});

      expect(options.map(option => option.value)).toEqual(['low', 'medium', 'high', 'max']);
    });

    it('keeps xhigh on supported opus models', () => {
      const options = claudeChatUIConfig.getReasoningOptions('claude-opus-4-7', {});

      expect(options.map(option => option.value)).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
      expect(options.find(option => option.value === 'medium')?.label).toBe('Medium');
      expect(options.find(option => option.value === 'xhigh')?.label).toBe('xHigh');
    });

    it('keeps xhigh on fable models', () => {
      const options = claudeChatUIConfig.getReasoningOptions('fable', {});

      expect(options.map(option => option.value)).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
    });

    it('uses effort options for custom model ids', () => {
      const options = claudeChatUIConfig.getReasoningOptions('custom-model', {});

      expect(options.map(option => option.value)).toEqual([
        'low',
        'medium',
        'high',
        'xhigh',
        'max',
      ]);
      expect(options.some(option => option.tokens !== undefined)).toBe(false);
    });
  });

  describe('applyModelDefaults', () => {
    it('clamps stale xhigh effort when switching to a custom sonnet model', () => {
      const settings: Record<string, unknown> = {
        effortLevel: 'xhigh',
        providerConfigs: {},
      };

      claudeChatUIConfig.applyModelDefaults('claude-sonnet-4-5', settings);

      expect(settings.effortLevel).toBe('high');
    });

    it('preserves xhigh on custom opus models that support it', () => {
      const settings: Record<string, unknown> = {
        effortLevel: 'xhigh',
        providerConfigs: {},
      };

      claudeChatUIConfig.applyModelDefaults('claude-opus-4-7', settings);

      expect(settings.effortLevel).toBe('xhigh');
    });
  });

  describe('applyModelProjectionDefaults', () => {
    it('preserves a user-selected effort for default tier models', () => {
      const settings: Record<string, unknown> = { effortLevel: 'low' };

      claudeChatUIConfig.applyModelProjectionDefaults?.('opus', settings);

      expect(settings.effortLevel).toBe('low');
    });

    it('preserves xhigh on the opus alias that supports it', () => {
      const settings: Record<string, unknown> = { effortLevel: 'xhigh' };

      claudeChatUIConfig.applyModelProjectionDefaults?.('opus', settings);

      expect(settings.effortLevel).toBe('xhigh');
    });

    it('clamps an effort the projected model cannot use', () => {
      const settings: Record<string, unknown> = { effortLevel: 'xhigh' };

      // The haiku alias does not support xhigh -> fall back to the default.
      claudeChatUIConfig.applyModelProjectionDefaults?.('haiku', settings);

      expect(settings.effortLevel).toBe('high');
    });
  });
});
