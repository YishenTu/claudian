import {
  getKimiDiscoveryState,
  updateKimiDiscoveryState,
} from '@/providers/kimi/discoveryState';
import { getKimiProviderSettings } from '@/providers/kimi/settings';
import { kimiChatUIConfig } from '@/providers/kimi/ui/KimiChatUIConfig';
import { KIMI_PROVIDER_ICON } from '@/shared/icons';

const mockModelMetadata: Record<string, {
  capabilities: string[];
  displayName?: string;
  maxContextSize?: number;
}> = {};

jest.mock('@/providers/kimi/app/KimiModelMetadata', () => ({
  getKimiModelMetadata: jest.fn(() => mockModelMetadata),
  refreshKimiModelMetadata: jest.fn(() => mockModelMetadata),
  resetKimiModelMetadataCache: jest.fn(),
}));

jest.mock('@/utils/env', () => ({
  ...jest.requireActual('@/utils/env'),
  getHostnameKey: () => 'device:current',
  getLegacyHostnameKey: () => 'legacy-host',
}));

const discovered = [
  { description: 'Kimi coding model', label: 'Kimi Coding', rawId: 'kimi-for-coding' },
  { label: 'K2', rawId: 'kimi-k2' },
];

const k2ThinkingOptions = [
  { label: 'Off', value: 'off' },
  { label: 'Low', value: 'low' },
  { label: 'Medium', value: 'medium' },
  { label: 'High', value: 'high' },
];

function makeSettings(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const settings: Record<string, unknown> = {
    providerConfigs: {
      kimi: {
        modelAliases: { 'kimi-for-coding': 'Fast Kimi' },
      },
    },
    ...overrides,
  };
  updateKimiDiscoveryState(settings, {
    currentThinkingByModel: { 'kimi-k2': 'medium' },
    discoveredModels: discovered,
    thinkingOptionsByModel: { 'kimi-k2': k2ThinkingOptions },
  });
  return settings;
}

describe('KimiChatUIConfig', () => {
  beforeEach(() => {
    for (const key of Object.keys(mockModelMetadata)) {
      delete mockModelMetadata[key];
    }
  });

  it('owns only kimi:-scoped selection ids', () => {
    expect(kimiChatUIConfig.ownsModel('kimi:kimi-for-coding', {})).toBe(true);
    expect(kimiChatUIConfig.ownsModel('kimi:', {})).toBe(false);
    expect(kimiChatUIConfig.ownsModel('kimi-for-coding', {})).toBe(false);
    expect(kimiChatUIConfig.ownsModel('grok/grok-4', {})).toBe(false);
    expect(kimiChatUIConfig.ownsModel('opencode:anthropic/claude-sonnet-4', {})).toBe(false);
    expect(kimiChatUIConfig.getProviderIcon?.()).toBe(KIMI_PROVIDER_ICON);
  });

  it('exposes the whole discovered catalog when visibleModels is null', () => {
    const options = kimiChatUIConfig.getModelOptions(makeSettings());

    expect(options).toEqual([
      {
        description: 'Kimi coding model',
        label: 'Fast Kimi',
        value: 'kimi:kimi-for-coding',
      },
      {
        description: 'ACP runtime',
        label: 'K2',
        value: 'kimi:kimi-k2',
      },
    ]);
    expect(getKimiDiscoveryState(makeSettings()).discoveredModels).toHaveLength(2);
  });

  it('restricts options to visibleModels with alias precedence and dedupe', () => {
    const settings = makeSettings();
    (settings.providerConfigs as Record<string, Record<string, unknown>>).kimi.visibleModels = [
      'kimi-k2',
      'kimi-k2',
      'kimi-for-coding',
      'kimi-unlisted',
    ];

    expect(kimiChatUIConfig.getModelOptions(settings)).toEqual([
      { description: 'ACP runtime', label: 'K2', value: 'kimi:kimi-k2' },
      {
        description: 'Kimi coding model',
        label: 'Fast Kimi',
        value: 'kimi:kimi-for-coding',
      },
      {
        description: 'Configured model',
        label: 'kimi-unlisted',
        value: 'kimi:kimi-unlisted',
      },
    ]);
  });

  it('returns no options and no default without a discovered catalog', () => {
    const settings: Record<string, unknown> = { providerConfigs: { kimi: {} } };

    expect(kimiChatUIConfig.getModelOptions(settings)).toEqual([]);
    expect(kimiChatUIConfig.getDefaultModel?.(settings)).toBeNull();
    expect(kimiChatUIConfig.getDefaultModel?.(makeSettings())).toBe('kimi:kimi-for-coding');
  });

  it('exposes discovered thinking options as reasoning effort', () => {
    const settings = makeSettings();

    expect(kimiChatUIConfig.isAdaptiveReasoningModel?.('kimi:kimi-k2', settings)).toBe(true);
    expect(kimiChatUIConfig.getReasoningOptions?.('kimi:kimi-k2', settings)).toEqual([
      { description: undefined, label: 'Off', value: 'off' },
      { description: undefined, label: 'Low', value: 'low' },
      { description: undefined, label: 'Medium', value: 'medium' },
      { description: undefined, label: 'High', value: 'high' },
    ]);
    expect(kimiChatUIConfig.getDefaultReasoningValue?.('kimi:kimi-k2', settings)).toBe('medium');
  });

  it('renders the effort selector from the persisted catalog after a reload', () => {
    // No updateKimiDiscoveryState call: the in-memory mirror starts cold, as
    // after a plugin reload, and must heal from the persisted provider config.
    const settings: Record<string, unknown> = {
      providerConfigs: {
        kimi: {
          currentThinkingByModel: { 'kimi-k2': 'medium' },
          discoveredModels: discovered,
          thinkingOptionsByModel: { 'kimi-k2': k2ThinkingOptions },
        },
      },
    };

    expect(kimiChatUIConfig.isAdaptiveReasoningModel?.('kimi:kimi-k2', settings)).toBe(true);
    expect(kimiChatUIConfig.getReasoningOptions?.('kimi:kimi-k2', settings)).toEqual([
      { description: undefined, label: 'Off', value: 'off' },
      { description: undefined, label: 'Low', value: 'low' },
      { description: undefined, label: 'Medium', value: 'medium' },
      { description: undefined, label: 'High', value: 'high' },
    ]);
    expect(kimiChatUIConfig.getDefaultReasoningValue?.('kimi:kimi-k2', settings)).toBe('medium');
  });

  it('exposes no reasoning controls for models without discovered thinking options', () => {
    const settings = makeSettings();

    expect(kimiChatUIConfig.isAdaptiveReasoningModel?.('kimi:kimi-for-coding', settings))
      .toBe(false);
    expect(kimiChatUIConfig.getReasoningOptions?.('kimi:kimi-for-coding', settings)).toEqual([]);
    expect(kimiChatUIConfig.getDefaultReasoningValue?.('kimi:kimi-for-coding', settings)).toBe('');
    expect(kimiChatUIConfig.getDefaultReasoningValue?.('grok/grok-4', settings)).toBe('');
    expect(kimiChatUIConfig.getModeSelector?.(settings)).toBeNull();
    expect(kimiChatUIConfig.getCustomModelIds?.({})).toEqual(new Set());
  });

  it('persists reasoning selections per model and drops unsupported values', () => {
    const settings = makeSettings();

    kimiChatUIConfig.applyReasoningSelection?.('kimi:kimi-k2', 'high', settings);
    expect(getKimiProviderSettings(settings).preferredThinkingByModel).toEqual({
      'kimi-k2': 'high',
    });
    expect(kimiChatUIConfig.getDefaultReasoningValue?.('kimi:kimi-k2', settings)).toBe('high');

    kimiChatUIConfig.applyReasoningSelection?.('kimi:kimi-k2', 'bogus', settings);
    expect(getKimiProviderSettings(settings).preferredThinkingByModel).toEqual({});

    expect(() => kimiChatUIConfig.applyReasoningSelection?.('grok/grok-4', 'high', settings))
      .not.toThrow();
    expect(() => kimiChatUIConfig.applyReasoningSelection?.('kimi:kimi-k2', 'high', null))
      .not.toThrow();
  });

  it('exposes the permission mode toggle with a plan affordance', () => {
    expect(kimiChatUIConfig.getPermissionModeToggle?.()).toEqual({
      inactiveValue: 'normal',
      inactiveLabel: 'Default',
      activeValue: 'yolo',
      activeLabel: 'YOLO',
      planValue: 'plan',
      planLabel: 'Plan',
    });

    const settings: Record<string, unknown> = {};
    kimiChatUIConfig.applyPermissionMode?.('plan', settings);
    expect(settings.permissionMode).toBe('plan');
    expect(() => kimiChatUIConfig.applyPermissionMode?.('plan', null)).not.toThrow();
  });

  it('resolves context windows from custom limits with a 200k fallback', () => {
    expect(kimiChatUIConfig.getContextWindowSize?.('kimi:kimi-k2')).toBe(200_000);
    expect(kimiChatUIConfig.getContextWindowSize?.('kimi:kimi-k2', {
      'kimi:kimi-k2': 256_000,
    })).toBe(256_000);
  });

  it('resolves context windows from config.toml metadata ahead of custom limits', () => {
    const settings = makeSettings();
    mockModelMetadata['kimi-k2'] = { capabilities: [], maxContextSize: 262_144 };

    expect(kimiChatUIConfig.getContextWindowSize?.('kimi:kimi-k2', {}, settings)).toBe(262_144);
    // Provider-owned metadata wins over custom limits, matching grok's precedence.
    expect(kimiChatUIConfig.getContextWindowSize?.('kimi:kimi-k2', {
      'kimi:kimi-k2': 128_000,
    }, settings)).toBe(262_144);
    expect(kimiChatUIConfig.getContextWindowSize?.('kimi:kimi-for-coding', {
      'kimi:kimi-for-coding': 128_000,
    }, settings)).toBe(128_000);
    // Without a settings bag there is no metadata lookup.
    expect(kimiChatUIConfig.getContextWindowSize?.('kimi:kimi-k2')).toBe(200_000);
  });

  it('falls back to config.toml display names only when ACP provided no label', () => {
    const settings = makeSettings();
    (settings.providerConfigs as Record<string, Record<string, unknown>>).kimi.visibleModels = [
      'kimi-k2',
      'kimi-k3-256k',
    ];
    mockModelMetadata['kimi-k2'] = { capabilities: [], displayName: 'K2 From Config' };
    mockModelMetadata['kimi-k3-256k'] = { capabilities: [], displayName: 'K3-256k' };

    expect(kimiChatUIConfig.getModelOptions(settings)).toEqual([
      // ACP-discovered label wins over the config.toml display name.
      { description: 'ACP runtime', label: 'K2', value: 'kimi:kimi-k2' },
      // No ACP entry for this model: the config.toml display name applies.
      { description: 'Configured model', label: 'K3-256k', value: 'kimi:kimi-k3-256k' },
    ]);
  });

  it('gates image input per model from config.toml capabilities', () => {
    const settings = makeSettings();
    mockModelMetadata['kimi-k2'] = { capabilities: ['thinking', 'image_in'] };
    mockModelMetadata['kimi-for-coding'] = { capabilities: ['thinking', 'tool_use'] };

    expect(kimiChatUIConfig.supportsImageInputForModel?.('kimi:kimi-k2', settings)).toBe(true);
    expect(kimiChatUIConfig.supportsImageInputForModel?.('kimi:kimi-for-coding', settings))
      .toBe(false);
    // Unknown models and foreign ids keep the provider-level default (enabled).
    expect(kimiChatUIConfig.supportsImageInputForModel?.('kimi:kimi-k3', settings)).toBe(true);
    expect(kimiChatUIConfig.supportsImageInputForModel?.('grok/grok-4', settings)).toBe(true);
  });

  it('applies kimi model defaults and seeds effort only for thinking-capable models', () => {
    const settings = makeSettings({
      effortLevel: 'high',
      model: 'grok/grok-4',
    });

    kimiChatUIConfig.applyModelDefaults?.('kimi:kimi-k2', settings);
    expect(settings.model).toBe('kimi:kimi-k2');
    expect(settings.effortLevel).toBe('medium');

    kimiChatUIConfig.applyModelDefaults?.('kimi:kimi-for-coding', settings);
    expect(settings.model).toBe('kimi:kimi-for-coding');
    expect(settings).not.toHaveProperty('effortLevel');

    const untouched: Record<string, unknown> = { effortLevel: 'high', model: 'grok/grok-4' };
    kimiChatUIConfig.applyModelDefaults?.('grok/grok-4', untouched);
    expect(untouched).toEqual({ effortLevel: 'high', model: 'grok/grok-4' });

    expect(() => kimiChatUIConfig.applyModelDefaults?.('kimi:kimi-k2', null)).not.toThrow();
    expect(kimiChatUIConfig.normalizeModelVariant?.('kimi:kimi-k2', {}))
      .toBe('kimi:kimi-k2');
    expect(kimiChatUIConfig.isDefaultModel?.('kimi:kimi-k2')).toBe(true);
    expect(kimiChatUIConfig.isDefaultModel?.('grok/grok-4')).toBe(false);
  });
});
