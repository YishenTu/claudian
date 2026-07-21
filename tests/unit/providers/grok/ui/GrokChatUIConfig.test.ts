import { getGrokProviderSettings } from '@/providers/grok/settings';
import { grokChatUIConfig } from '@/providers/grok/ui/GrokChatUIConfig';
import { GROK_PROVIDER_ICON } from '@/shared/icons';

const catalog = {
  defaultModelId: 'grok-4',
  fingerprint: 'catalog-fingerprint',
  models: [
    {
      contextWindow: 256_000,
      defaultReasoningEffort: 'medium',
      description: 'xAI coding model',
      displayName: 'Grok 4',
      rawId: 'grok-4',
      reasoningEfforts: [
        { description: 'Fast', label: 'Low Effort', value: 'low' },
        { label: 'Medium Effort', value: 'medium' },
        { label: 'High Effort', value: 'high' },
      ],
      supportsReasoning: true,
    },
    {
      description: 'Custom Kimi alias',
      displayName: 'Kimi Coding',
      rawId: 'kimi-coding',
      reasoningEfforts: [],
      supportsReasoning: false,
    },
  ],
  refreshedAt: 100,
};

function makeSettings(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    providerConfigs: {
      grok: {
        catalogsByHost: {
          'device:current': catalog,
        },
        modelAliases: {
          'grok-4': 'Fast Grok',
        },
        preferredReasoningByModel: {
          'grok-4': 'high',
        },
        visibleModels: ['grok-4'],
      },
    },
    ...overrides,
  };
}

jest.mock('@/utils/env', () => ({
  ...jest.requireActual('@/utils/env'),
  getHostnameKey: () => 'device:current',
  getLegacyHostnameKey: () => 'legacy-host',
}));

describe('GrokChatUIConfig', () => {
  it('owns only the reserved native default and provider-qualified Grok models', () => {
    expect(grokChatUIConfig.ownsModel('grok', {})).toBe(true);
    expect(grokChatUIConfig.ownsModel('grok/grok-4', {})).toBe(true);
    expect(grokChatUIConfig.ownsModel('grok/', {})).toBe(false);
    expect(grokChatUIConfig.ownsModel('grok-4', {})).toBe(false);
    expect(grokChatUIConfig.getDefaultModel?.({})).toBe('grok');
    expect(grokChatUIConfig.getProviderIcon?.()).toBe(GROK_PROVIDER_ICON);
  });

  it('always exposes native default and applies visibility and aliases to catalog models', () => {
    expect(grokChatUIConfig.getModelOptions(makeSettings())).toEqual([
      {
        description: 'Use the model selected by Grok',
        label: 'Grok (native default)',
        value: 'grok',
      },
      expect.objectContaining({
        description: 'xAI coding model',
        label: 'Fast Grok',
        value: 'grok/grok-4',
      }),
    ]);

    expect(grokChatUIConfig.getModelOptions(makeSettings({
      providerConfigs: {
        grok: {
          catalogsByHost: { 'device:current': catalog },
          visibleModels: null,
        },
      },
    })).map(option => option.value)).toEqual([
      'grok',
      'grok/grok-4',
      'grok/kimi-coding',
    ]);
  });

  it('pins the active and saved session selections even when hidden from the picker', () => {
    const options = grokChatUIConfig.getModelOptions(makeSettings({
      model: 'grok/kimi-coding',
      savedProviderModel: { grok: 'grok/retired-alias' },
    }));

    expect(options).toEqual([
      expect.objectContaining({ value: 'grok' }),
      expect.objectContaining({ value: 'grok/grok-4' }),
      expect.objectContaining({
        description: 'Custom Kimi alias',
        label: 'Kimi Coding',
        value: 'grok/kimi-coding',
      }),
      expect.objectContaining({
        description: 'Selected in an existing session',
        label: 'retired-alias',
        value: 'grok/retired-alias',
      }),
    ]);
  });

  it('pins a hidden title-generation selection so reconciliation does not discard it', () => {
    const options = grokChatUIConfig.getModelOptions(makeSettings({
      titleGenerationModel: 'grok/kimi-coding',
    }));

    expect(options).toContainEqual(expect.objectContaining({
      label: 'Kimi Coding',
      value: 'grok/kimi-coding',
    }));
  });

  it('projects reasoning options, defaults, and preferences from model metadata', () => {
    const settings = makeSettings();

    expect(grokChatUIConfig.isAdaptiveReasoningModel('grok/grok-4', settings)).toBe(true);
    expect(grokChatUIConfig.isAdaptiveReasoningModel('grok/kimi-coding', settings)).toBe(false);
    expect(grokChatUIConfig.getReasoningOptions('grok/grok-4', settings)).toEqual([
      { description: 'Fast', label: 'Low', value: 'low' },
      { label: 'Medium', value: 'medium' },
      { label: 'High', value: 'high' },
    ]);
    expect(grokChatUIConfig.getDefaultReasoningValue('grok/grok-4', settings)).toBe('high');

    grokChatUIConfig.applyReasoningSelection?.('grok/grok-4', 'low', settings);
    expect(getGrokProviderSettings(settings).preferredReasoningByModel).toEqual({
      'grok-4': 'low',
    });

    grokChatUIConfig.applyModelDefaults('grok/grok-4', settings);
    expect(settings.model).toBe('grok/grok-4');
    expect(settings.effortLevel).toBe('low');

    settings.effortLevel = 'medium';
    grokChatUIConfig.applyModelProjectionDefaults?.('grok/grok-4', settings);
    expect(settings.effortLevel).toBe('low');
  });

  it('does not project reasoning metadata onto the synthetic native-default selection', () => {
    const settings = makeSettings({
      effortLevel: 'medium',
      savedProviderEffort: { claude: 'high', grok: 'medium' },
    });

    expect(grokChatUIConfig.isAdaptiveReasoningModel('grok', settings)).toBe(false);
    expect(grokChatUIConfig.getReasoningOptions('grok', settings)).toEqual([]);
    expect(grokChatUIConfig.getDefaultReasoningValue('grok', settings)).toBe('');
    expect(grokChatUIConfig.getContextWindowSize('grok', undefined, settings)).toBe(256_000);

    grokChatUIConfig.applyReasoningSelection?.('grok', 'low', settings);
    expect(getGrokProviderSettings(settings).preferredReasoningByModel).toEqual({
      'grok-4': 'high',
    });
    expect(settings.effortLevel).toBeUndefined();
    expect(settings.savedProviderEffort).toEqual({ claude: 'high' });

    settings.effortLevel = 'low';
    (settings.savedProviderEffort as Record<string, string>).grok = 'low';
    grokChatUIConfig.applyModelProjectionDefaults?.('grok', settings);
    expect(settings.effortLevel).toBeUndefined();
    expect(settings.savedProviderEffort).toEqual({ claude: 'high' });
    expect(grokChatUIConfig.normalizeModelVariant('grok', settings)).toBe('grok');
  });

  it('preserves explicit model preferences across a synthetic selection', () => {
    const settings = makeSettings({
      effortLevel: 'medium',
      savedProviderEffort: { grok: 'medium' },
    });

    grokChatUIConfig.applyModelDefaults('grok/grok-4', settings);
    expect(settings.effortLevel).toBe('high');

    grokChatUIConfig.applyReasoningSelection?.('grok/grok-4', 'low', settings);
    grokChatUIConfig.applyModelDefaults('grok', settings);
    expect(settings.effortLevel).toBeUndefined();
    expect(settings.savedProviderEffort).toEqual({});
    expect(getGrokProviderSettings(settings).preferredReasoningByModel).toEqual({
      'grok-4': 'low',
    });

    grokChatUIConfig.applyModelProjectionDefaults?.('grok/grok-4', settings);
    expect(settings.effortLevel).toBe('low');
    expect(getGrokProviderSettings(settings).preferredReasoningByModel).toEqual({
      'grok-4': 'low',
    });
  });

  it('resolves model context before custom limits and the provider fallback', () => {
    const settings = makeSettings();

    expect(grokChatUIConfig.getContextWindowSize(
      'grok/grok-4',
      { 'grok/grok-4': 100_000 },
      settings,
    )).toBe(256_000);
    expect(grokChatUIConfig.getContextWindowSize(
      'grok/unknown',
      { 'grok/unknown': 123_000 },
      settings,
    )).toBe(123_000);
    expect(grokChatUIConfig.getContextWindowSize('grok/unknown', undefined, settings)).toBe(200_000);
  });

  it('normalizes explicit ids without replacing hidden current selections', () => {
    const settings = makeSettings({ model: 'grok/kimi-coding' });

    expect(grokChatUIConfig.normalizeModelVariant(' grok/kimi-coding ', settings))
      .toBe('grok/kimi-coding');
    expect(grokChatUIConfig.normalizeModelVariant('grok', settings)).toBe('grok');
    expect(grokChatUIConfig.normalizeModelVariant('claude', settings)).toBe('claude');
  });

  it('exposes only Safe and YOLO without a plan or provider mode selector', () => {
    expect(grokChatUIConfig.getPermissionModeToggle?.()).toEqual({
      activeLabel: 'YOLO',
      activeValue: 'yolo',
      inactiveLabel: 'Safe',
      inactiveValue: 'normal',
    });
    expect(grokChatUIConfig.getPermissionModeToggle?.()).not.toHaveProperty('planValue');
    expect(grokChatUIConfig.getModeSelector?.({})).toBeNull();

    const settings: Record<string, unknown> = { permissionMode: 'plan' };
    expect(grokChatUIConfig.resolvePermissionMode?.(settings)).toBe('normal');
    grokChatUIConfig.applyPermissionMode?.('yolo', settings);
    expect(settings.permissionMode).toBe('yolo');
    grokChatUIConfig.applyPermissionMode?.('plan', settings);
    expect(settings.permissionMode).toBe('normal');
  });
});
