import {
  getKimiDiscoveryState,
  updateKimiDiscoveryState,
} from '@/providers/kimi/discoveryState';
import { kimiChatUIConfig } from '@/providers/kimi/ui/KimiChatUIConfig';
import { KIMI_PROVIDER_ICON } from '@/shared/icons';

jest.mock('@/utils/env', () => ({
  ...jest.requireActual('@/utils/env'),
  getHostnameKey: () => 'device:current',
  getLegacyHostnameKey: () => 'legacy-host',
}));

const discovered = [
  { description: 'Kimi coding model', label: 'Kimi Coding', rawId: 'kimi-for-coding' },
  { label: 'K2', rawId: 'kimi-k2' },
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
  updateKimiDiscoveryState(settings, { discoveredModels: discovered });
  return settings;
}

describe('KimiChatUIConfig', () => {
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

  it('exposes no reasoning or effort controls', () => {
    const settings = makeSettings();

    expect(kimiChatUIConfig.isAdaptiveReasoningModel?.('kimi:kimi-k2,thinking', settings))
      .toBe(false);
    expect(kimiChatUIConfig.getReasoningOptions?.('kimi:kimi-k2,thinking', settings)).toEqual([]);
    expect(kimiChatUIConfig.getDefaultReasoningValue?.('kimi:kimi-k2,thinking', settings)).toBe('');
    expect(kimiChatUIConfig.getModeSelector?.(settings)).toBeNull();
    expect(kimiChatUIConfig.getPermissionModeToggle?.()).toBeNull();
    expect(kimiChatUIConfig.getCustomModelIds?.({})).toEqual(new Set());
  });

  it('resolves context windows from custom limits with a 200k fallback', () => {
    expect(kimiChatUIConfig.getContextWindowSize?.('kimi:kimi-k2')).toBe(200_000);
    expect(kimiChatUIConfig.getContextWindowSize?.('kimi:kimi-k2', {
      'kimi:kimi-k2': 256_000,
    })).toBe(256_000);
  });

  it('applies kimi model defaults and strips effort state only for kimi models', () => {
    const settings: Record<string, unknown> = {
      effortLevel: 'high',
      model: 'grok/grok-4',
    };

    kimiChatUIConfig.applyModelDefaults?.('kimi:kimi-k2', settings);
    expect(settings).toEqual({ model: 'kimi:kimi-k2' });

    const untouched: Record<string, unknown> = { effortLevel: 'high', model: 'grok/grok-4' };
    kimiChatUIConfig.applyModelDefaults?.('grok/grok-4', untouched);
    expect(untouched).toEqual({ effortLevel: 'high', model: 'grok/grok-4' });

    expect(() => kimiChatUIConfig.applyModelDefaults?.('kimi:kimi-k2', null)).not.toThrow();
    expect(kimiChatUIConfig.normalizeModelVariant?.('kimi:kimi-k2,thinking', {}))
      .toBe('kimi:kimi-k2,thinking');
    expect(kimiChatUIConfig.isDefaultModel?.('kimi:kimi-k2')).toBe(true);
    expect(kimiChatUIConfig.isDefaultModel?.('grok/grok-4')).toBe(false);
  });
});
