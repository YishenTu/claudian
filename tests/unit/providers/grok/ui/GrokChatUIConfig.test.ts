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
      reasoningMetadataResolved: true,
      reasoningEfforts: [
        { description: 'Fastest', label: 'Minimal Effort', value: 'minimal' },
        { label: 'High Effort', value: 'high' },
        { label: 'Extra High Effort', value: 'xhigh' },
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
  it('owns only enabled provider-qualified Grok models and resolves the enabled default', () => {
    expect(grokChatUIConfig.ownsModel('grok', {})).toBe(false);
    expect(grokChatUIConfig.ownsModel('grok/grok-4', makeSettings())).toBe(true);
    expect(grokChatUIConfig.ownsModel('grok/kimi-coding', makeSettings())).toBe(false);
    expect(grokChatUIConfig.ownsModel('grok/', {})).toBe(false);
    expect(grokChatUIConfig.ownsModel('grok-4', {})).toBe(false);
    expect(grokChatUIConfig.getDefaultModel?.({})).toBeNull();
    expect(grokChatUIConfig.getDefaultModel?.(makeSettings())).toBe('grok/grok-4');
    expect(grokChatUIConfig.getProviderIcon?.()).toBe(GROK_PROVIDER_ICON);
  });

  it('exposes only discovered models and applies visibility and aliases', () => {
    expect(grokChatUIConfig.getModelOptions(makeSettings())).toEqual([
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
      'grok/grok-4',
      'grok/kimi-coding',
    ]);
  });

  it('does not expose active or saved selections that the user disabled', () => {
    const options = grokChatUIConfig.getModelOptions(makeSettings({
      model: 'grok/kimi-coding',
      savedProviderModel: { grok: 'grok/retired-alias' },
    }));

    expect(options.map(option => option.value)).toEqual(['grok/grok-4']);
  });

  it('does not expose a disabled title-generation selection', () => {
    const options = grokChatUIConfig.getModelOptions(makeSettings({
      titleGenerationModel: 'grok/kimi-coding',
    }));

    expect(options.map(option => option.value)).toEqual(['grok/grok-4']);
  });

  it('uses the first enabled model when the native catalog default is disabled', () => {
    const settings = makeSettings({
      providerConfigs: {
        grok: {
          catalogsByHost: { 'device:current': catalog },
          visibleModels: ['kimi-coding'],
        },
      },
    });

    expect(grokChatUIConfig.getDefaultModel?.(settings)).toBe('grok/kimi-coding');
    expect(grokChatUIConfig.getModelOptions(settings).map(option => option.value))
      .toEqual(['grok/kimi-coding']);
  });

  it('has no default or options when the user enables no models', () => {
    const settings = makeSettings({
      providerConfigs: {
        grok: {
          catalogsByHost: { 'device:current': catalog },
          visibleModels: [],
        },
      },
    });

    expect(grokChatUIConfig.getDefaultModel?.(settings)).toBeNull();
    expect(grokChatUIConfig.getModelOptions(settings)).toEqual([]);
  });

  it('projects reasoning options, defaults, and preferences from model metadata', () => {
    const settings = makeSettings();

    expect(grokChatUIConfig.isAdaptiveReasoningModel('grok/grok-4', settings)).toBe(true);
    expect(grokChatUIConfig.isAdaptiveReasoningModel('grok/kimi-coding', settings)).toBe(false);
    expect(grokChatUIConfig.getReasoningOptions('grok/grok-4', settings)).toEqual([
      { description: 'Fastest', label: 'Minimal', value: 'minimal' },
      { label: 'High', value: 'high' },
      { label: 'xHigh', value: 'xhigh' },
    ]);
    expect(grokChatUIConfig.getDefaultReasoningValue('grok/grok-4', settings)).toBe('high');

    grokChatUIConfig.applyReasoningSelection?.('grok/grok-4', 'xhigh', settings);
    expect(getGrokProviderSettings(settings).preferredReasoningByModel).toEqual({
      'grok-4': 'xhigh',
    });

    grokChatUIConfig.applyModelDefaults('grok/grok-4', settings);
    expect(settings.model).toBe('grok/grok-4');
    expect(settings.effortLevel).toBe('xhigh');

    settings.effortLevel = 'medium';
    grokChatUIConfig.applyModelProjectionDefaults?.('grok/grok-4', settings);
    expect(settings.effortLevel).toBe('xhigh');
  });

  it('uses and persists the standard fallback for models without reasoning metadata', () => {
    const settings = makeSettings({
      providerConfigs: {
        grok: {
          catalogsByHost: { 'device:current': catalog },
          preferredReasoningByModel: { 'grok-4': 'high' },
          visibleModels: ['grok-4', 'kimi-coding'],
        },
      },
    });

    expect(grokChatUIConfig.getReasoningOptions('grok/kimi-coding', settings)).toEqual([
      { label: 'Low', value: 'low' },
      { label: 'Medium', value: 'medium' },
      { label: 'High', value: 'high' },
    ]);
    expect(grokChatUIConfig.getDefaultReasoningValue('grok/kimi-coding', settings)).toBe('high');

    grokChatUIConfig.applyReasoningSelection?.('grok/kimi-coding', 'medium', settings);
    expect(getGrokProviderSettings(settings).preferredReasoningByModel).toEqual({
      'grok-4': 'high',
      'kimi-coding': 'medium',
    });
  });

  it('hides reasoning after ACP resolves an enabled model as non-reasoning', () => {
    const resolvedCatalog = {
      ...catalog,
      models: catalog.models.map(model => model.rawId === 'kimi-coding'
        ? { ...model, reasoningMetadataResolved: true }
        : model),
    };
    const settings = makeSettings({
      providerConfigs: {
        grok: {
          catalogsByHost: { 'device:current': resolvedCatalog },
          visibleModels: ['kimi-coding'],
        },
      },
    });

    expect(grokChatUIConfig.isAdaptiveReasoningModel('grok/kimi-coding', settings)).toBe(false);
    expect(grokChatUIConfig.getReasoningOptions('grok/kimi-coding', settings)).toEqual([]);
    expect(grokChatUIConfig.getDefaultReasoningValue('grok/kimi-coding', settings)).toBe('');
  });

  it('preserves explicit model preferences across projection updates', () => {
    const settings = makeSettings({
      effortLevel: 'medium',
      savedProviderEffort: { grok: 'medium' },
    });

    grokChatUIConfig.applyModelDefaults('grok/grok-4', settings);
    expect(settings.effortLevel).toBe('high');

    grokChatUIConfig.applyReasoningSelection?.('grok/grok-4', 'xhigh', settings);
    grokChatUIConfig.applyModelProjectionDefaults?.('grok/grok-4', settings);
    expect(settings.effortLevel).toBe('xhigh');
    expect(getGrokProviderSettings(settings).preferredReasoningByModel).toEqual({
      'grok-4': 'xhigh',
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
