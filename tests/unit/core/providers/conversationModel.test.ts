import {
  getConversationModelPersistenceTarget,
  resolveConversationModel,
  resolveNewConversationModel,
} from '@/core/providers/conversationModel';
import { ProviderRegistry } from '@/core/providers/ProviderRegistry';
import type { ProviderChatUIConfig, ProviderId } from '@/core/providers/types';

interface TestProviderConfig {
  defaultModel?: string | null;
  normalizations?: Record<string, string>;
  options: string[];
  variantFallback?: string;
}

function createUiConfig(config: TestProviderConfig): ProviderChatUIConfig {
  return {
    getModelOptions: () => config.options.map(value => ({ label: value, value })),
    getCustomModelIds: () => new Set(),
    getDefaultModel: () => config.defaultModel ?? null,
    ownsModel: model => config.options.includes(model),
    isAdaptiveReasoningModel: () => false,
    getReasoningOptions: () => [],
    getDefaultReasoningValue: () => 'off',
    getContextWindowSize: () => 200_000,
    isDefaultModel: () => false,
    applyModelDefaults: () => undefined,
    normalizeAvailableModelSelection: model => config.normalizations?.[model] ?? model,
    normalizeModelVariant: model => config.variantFallback ?? model,
  };
}

describe('conversation model resolution', () => {
  const providers: Record<ProviderId, TestProviderConfig> = {
    claude: { defaultModel: 'opus', options: ['haiku', 'opus'] },
    codex: { defaultModel: 'codex/gpt-5', options: ['codex/gpt-5', 'codex/gpt-5-mini'] },
    empty: { defaultModel: null, options: [] },
  };

  beforeEach(() => {
    providers.claude = { defaultModel: 'opus', options: ['haiku', 'opus'] };
    providers.codex = {
      defaultModel: 'codex/gpt-5',
      options: ['codex/gpt-5', 'codex/gpt-5-mini'],
    };
    providers.empty = { defaultModel: null, options: [] };
    jest.spyOn(ProviderRegistry, 'getRegisteredProviderIds')
      .mockReturnValue(Object.keys(providers));
    jest.spyOn(ProviderRegistry, 'getChatUIConfig')
      .mockImplementation(providerId => createUiConfig(providers[providerId ?? 'claude']!));
    jest.spyOn(ProviderRegistry, 'isEnabled')
      .mockImplementation((providerId, settings) => (
        ((settings.enabledProviders as string[] | undefined) ?? []).includes(providerId)
      ));
    jest.spyOn(ProviderRegistry, 'getBlankTabProviderIds')
      .mockImplementation(settings => (
        ((settings.displayOrder as string[] | undefined) ?? [])
          .filter(providerId => ProviderRegistry.isEnabled(providerId, settings))
      ));
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('resolveNewConversationModel', () => {
    it('uses the provider-qualified global selection when it is currently available', () => {
      const result = resolveNewConversationModel({
        displayOrder: ['claude', 'codex'],
        enabledProviders: ['claude', 'codex'],
        lastSelectedChatModel: { providerId: 'codex', model: 'codex/gpt-5-mini' },
      });

      expect(result).toEqual({
        model: 'codex/gpt-5-mini',
        providerId: 'codex',
        source: 'last-selected',
      });
    });

    it('applies provider normalization before treating the global selection as unavailable', () => {
      providers.claude.options = ['claude-code/claude-opus-enterprise'];
      providers.claude.normalizations = {
        opus: 'claude-code/claude-opus-enterprise',
      };

      expect(resolveNewConversationModel({
        displayOrder: ['claude'],
        enabledProviders: ['claude'],
        lastSelectedChatModel: { providerId: 'claude', model: 'opus' },
      })).toEqual({
        model: 'claude-code/claude-opus-enterprise',
        providerId: 'claude',
        source: 'last-selected',
      });

      providers.claude.options = ['haiku', 'opus'];
      providers.claude.normalizations = undefined;
    });

    it('falls back to the same provider default when the global model is unavailable', () => {
      const result = resolveNewConversationModel({
        displayOrder: ['claude', 'codex'],
        enabledProviders: ['claude', 'codex'],
        lastSelectedChatModel: { providerId: 'codex', model: 'codex/retired' },
      });

      expect(result).toEqual({
        model: 'codex/gpt-5',
        providerId: 'codex',
        source: 'provider-default',
      });
    });

    it('does not let provider variant fallback bypass the explicit ordered default', () => {
      providers.codex.defaultModel = 'codex/gpt-ordered';
      providers.codex.options = ['codex/gpt-ordered', 'codex/gpt-native'];
      providers.codex.variantFallback = 'codex/gpt-native';

      expect(resolveNewConversationModel({
        displayOrder: ['codex'],
        enabledProviders: ['codex'],
        lastSelectedChatModel: { providerId: 'codex', model: 'codex/retired' },
      })).toEqual({
        model: 'codex/gpt-ordered',
        providerId: 'codex',
        source: 'provider-default',
      });
    });

    it('falls back to the first available provider default in explicit display order', () => {
      const result = resolveNewConversationModel({
        displayOrder: ['claude', 'codex'],
        enabledProviders: ['claude', 'codex'],
        lastSelectedChatModel: { providerId: 'disabled', model: 'disabled/model' },
      });

      expect(result).toEqual({
        model: 'opus',
        providerId: 'claude',
        source: 'provider-fallback',
      });
    });

    it('skips enabled providers with no available options', () => {
      const result = resolveNewConversationModel({
        displayOrder: ['empty', 'codex'],
        enabledProviders: ['empty', 'codex'],
        lastSelectedChatModel: { providerId: 'empty', model: 'empty/model' },
      });

      expect(result).toEqual({
        model: 'codex/gpt-5',
        providerId: 'codex',
        source: 'provider-fallback',
      });
    });

    it('returns null when no enabled provider exposes a model', () => {
      expect(resolveNewConversationModel({
        displayOrder: ['empty'],
        enabledProviders: ['empty'],
        lastSelectedChatModel: null,
      })).toBeNull();
    });
  });

  describe('resolveConversationModel', () => {
    it('exposes one persistence target for normalized and fallback replacements', () => {
      expect(getConversationModelPersistenceTarget({
        model: 'canonical-model',
        shouldPersist: true,
        source: 'selected',
      })).toBe('canonical-model');
      expect(getConversationModelPersistenceTarget({
        model: 'retired-model',
        modelToPersist: 'provider-default',
        shouldPersist: true,
        source: 'selected',
      })).toBe('provider-default');
    });

    it('keeps a stored conversation selection that is currently available', () => {
      expect(resolveConversationModel(
        {},
        'claude',
        { selectedModel: 'haiku' } as any,
      )).toEqual({
        model: 'haiku',
        shouldPersist: false,
        source: 'selected',
      });
    });

    it('applies provider normalization before replacing a stored conversation selection', () => {
      providers.claude.options = ['claude-code/claude-opus-enterprise'];
      providers.claude.normalizations = {
        opus: 'claude-code/claude-opus-enterprise',
      };

      expect(resolveConversationModel(
        {},
        'claude',
        { selectedModel: 'opus' } as any,
      )).toEqual({
        model: 'claude-code/claude-opus-enterprise',
        shouldPersist: true,
        source: 'selected',
      });

      providers.claude.options = ['haiku', 'opus'];
      providers.claude.normalizations = undefined;
    });

    it('persists a provider default for an unavailable usage-derived legacy model', () => {
      expect(resolveConversationModel(
        {},
        'claude',
        { usage: { model: 'retired-claude-model' } } as any,
      )).toEqual({
        model: 'opus',
        shouldPersist: true,
        source: 'usage',
      });
    });

    it('keeps an unavailable stored model readable until its provider default is durable', () => {
      expect(resolveConversationModel(
        {},
        'claude',
        { selectedModel: 'retired-claude-model' } as any,
      )).toEqual({
        model: 'retired-claude-model',
        modelToPersist: 'opus',
        shouldPersist: true,
        source: 'selected',
      });
    });

    it('uses the explicit ordered default instead of a provider variant fallback', () => {
      providers.codex.defaultModel = 'codex/gpt-ordered';
      providers.codex.options = ['codex/gpt-ordered', 'codex/gpt-native'];
      providers.codex.variantFallback = 'codex/gpt-native';

      expect(resolveConversationModel(
        {},
        'codex',
        { selectedModel: 'codex/retired' } as any,
      )).toEqual({
        model: 'codex/retired',
        modelToPersist: 'codex/gpt-ordered',
        shouldPersist: true,
        source: 'selected',
      });
    });

    it('preserves a stored historical selection when the provider has no authoritative options', () => {
      expect(resolveConversationModel(
        {},
        'empty',
        { selectedModel: 'empty/historical' } as any,
      )).toEqual({
        model: 'empty/historical',
        shouldPersist: false,
        source: 'selected',
      });
    });

    it('uses the first available option when a provider default is invalid', () => {
      providers.claude.defaultModel = 'retired-default';

      expect(resolveConversationModel(
        {},
        'claude',
        { selectedModel: 'retired-claude-model' } as any,
      )).toEqual({
        model: 'retired-claude-model',
        modelToPersist: 'haiku',
        shouldPersist: true,
        source: 'selected',
      });

      providers.claude.defaultModel = 'opus';
    });
  });
});
