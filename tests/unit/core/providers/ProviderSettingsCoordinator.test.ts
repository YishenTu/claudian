import '@/providers';

import { ProviderRegistry } from '@/core/providers/ProviderRegistry';
import { ProviderSettingsCoordinator } from '@/core/providers/ProviderSettingsCoordinator';
import type { Conversation } from '@/core/types';
import { DEFAULT_CLAUDE_PROVIDER_SETTINGS } from '@/providers/claude/settings';
import { DEFAULT_CODEX_PRIMARY_MODEL } from '@/providers/codex/types/models';

describe('ProviderSettingsCoordinator', () => {
  describe('normalizeProviderSelection', () => {
    it('falls back to claude when codex is disabled', () => {
      const settings: Record<string, unknown> = {
        settingsProvider: 'codex',
        providerConfigs: {
          codex: { enabled: false },
        },
      };

      const changed = ProviderSettingsCoordinator.normalizeProviderSelection(settings);

      expect(changed).toBe(true);
      expect(settings.settingsProvider).toBe('claude');
    });

    it('falls back to claude for unknown providers', () => {
      const settings: Record<string, unknown> = {
        settingsProvider: 'mystery-provider',
        providerConfigs: {
          codex: { enabled: true },
        },
      };

      const changed = ProviderSettingsCoordinator.normalizeProviderSelection(settings);

      expect(changed).toBe(true);
      expect(settings.settingsProvider).toBe('claude');
    });

    it('returns false when already normalized (no-op)', () => {
      const settings: Record<string, unknown> = {
        settingsProvider: 'claude',
        providerConfigs: {
          codex: { enabled: false },
        },
      };
      expect(ProviderSettingsCoordinator.normalizeProviderSelection(settings)).toBe(false);
    });
  });

  describe('reconcileAllProviders', () => {
    it('delegates to each registered provider reconciler with its own conversations', () => {
      const settings: Record<string, unknown> = { model: 'haiku' };
      const claudeConv = { providerId: 'claude', messages: [] } as unknown as Conversation;
      const conversations = [claudeConv];

      const result = ProviderSettingsCoordinator.reconcileAllProviders(settings, conversations);

      expect(result).toHaveProperty('changed');
      expect(result).toHaveProperty('invalidatedConversations');
      expect(Array.isArray(result.invalidatedConversations)).toBe(true);
    });

    it('filters conversations per provider', () => {
      const reconcileSpy = jest.spyOn(
        ProviderRegistry.getSettingsReconciler('claude'),
        'reconcileModelWithEnvironment',
      );

      const claudeConv = { providerId: 'claude', messages: [] } as unknown as Conversation;
      const otherConv = { providerId: 'codex', messages: [] } as unknown as Conversation;
      const settings: Record<string, unknown> = { model: 'haiku' };

      ProviderSettingsCoordinator.reconcileAllProviders(settings, [claudeConv, otherConv]);

      // Claude reconciler should only receive claude conversations
      expect(reconcileSpy).toHaveBeenCalledWith(
        settings,
        [claudeConv],
      );

      reconcileSpy.mockRestore();
    });
  });

  describe('normalizeAllModelVariants', () => {
    it('delegates to registered providers', () => {
      const settings: Record<string, unknown> = { model: 'haiku' };
      const result = ProviderSettingsCoordinator.normalizeAllModelVariants(settings);
      expect(typeof result).toBe('boolean');
    });

    it('migrates the active Codex primary model when an older built-in value is persisted', () => {
      const settings: Record<string, unknown> = {
        settingsProvider: 'codex',
        model: 'gpt-5.4',
        providerConfigs: {
          codex: { enabled: true },
        },
        savedProviderModel: { codex: 'gpt-5.4' },
      };

      expect(ProviderSettingsCoordinator.normalizeAllModelVariants(settings)).toBe(true);
      expect(settings.model).toBe(DEFAULT_CODEX_PRIMARY_MODEL);
      expect(settings.savedProviderModel).toEqual({ codex: DEFAULT_CODEX_PRIMARY_MODEL });
    });
  });

  describe('reconcileTitleGenerationModelSelection', () => {
    it('keeps custom title models while they are still available', () => {
      const settings: Record<string, unknown> = {
        titleGenerationModel: 'claude-opus-4-6',
        providerConfigs: {
          claude: {
            ...DEFAULT_CLAUDE_PROVIDER_SETTINGS,
            customModels: 'claude-opus-4-6',
          },
        },
      };

      expect(
        ProviderSettingsCoordinator.reconcileTitleGenerationModelSelection(settings),
      ).toBe(false);
      expect(settings.titleGenerationModel).toBe('claude-opus-4-6');
    });

    it('clears titleGenerationModel when no provider exposes the saved model', () => {
      const settings: Record<string, unknown> = {
        titleGenerationModel: 'claude-opus-4-6',
        providerConfigs: {
          claude: {
            ...DEFAULT_CLAUDE_PROVIDER_SETTINGS,
            customModels: '',
          },
        },
      };

      expect(
        ProviderSettingsCoordinator.reconcileTitleGenerationModelSelection(settings),
      ).toBe(true);
      expect(settings.titleGenerationModel).toBe('');
    });
  });

  describe('projectActiveProviderState', () => {
    it('projects saved model/effort/budget for the settings provider', () => {
      const settings: Record<string, unknown> = {
        settingsProvider: 'codex',
        providerConfigs: {
          codex: { enabled: true },
        },
        model: 'haiku',
        effortLevel: 'high',
        serviceTier: 'default',
        thinkingBudget: 'off',
        savedProviderModel: { codex: DEFAULT_CODEX_PRIMARY_MODEL, claude: 'haiku' },
        savedProviderEffort: { codex: 'medium', claude: 'high' },
        savedProviderServiceTier: { codex: 'fast', claude: 'default' },
        savedProviderThinkingBudget: { codex: '1024', claude: 'off' },
      };

      ProviderSettingsCoordinator.projectActiveProviderState(settings);

      expect(settings.model).toBe(DEFAULT_CODEX_PRIMARY_MODEL);
      expect(settings.effortLevel).toBe('medium');
      expect(settings.serviceTier).toBe('fast');
      expect(settings.thinkingBudget).toBe('1024');
    });

    it('migrates a saved legacy Codex model before projecting provider state', () => {
      const settings: Record<string, unknown> = {
        settingsProvider: 'claude',
        model: 'haiku',
        effortLevel: 'high',
        serviceTier: 'default',
        thinkingBudget: 'off',
        providerConfigs: {
          codex: { enabled: true },
        },
        savedProviderModel: { claude: 'haiku', codex: 'gpt-5.4' },
        savedProviderEffort: { claude: 'high', codex: 'medium' },
        savedProviderServiceTier: { claude: 'default', codex: 'fast' },
        savedProviderThinkingBudget: { claude: 'off', codex: 'off' },
      };

      const snapshot = ProviderSettingsCoordinator.getProviderSettingsSnapshot(settings, 'codex');

      expect(snapshot.model).toBe(DEFAULT_CODEX_PRIMARY_MODEL);
      expect(snapshot.serviceTier).toBe('fast');
    });

    it('defaults to claude when settingsProvider is not set', () => {
      const settings: Record<string, unknown> = {
        model: 'old-model',
        effortLevel: 'low',
        serviceTier: 'default',
        thinkingBudget: '500',
        savedProviderModel: { claude: 'sonnet' },
        savedProviderEffort: { claude: 'high' },
        savedProviderServiceTier: { claude: 'default' },
        savedProviderThinkingBudget: { claude: 'off' },
      };

      ProviderSettingsCoordinator.projectActiveProviderState(settings);

      expect(settings.model).toBe('sonnet');
      expect(settings.effortLevel).toBe('high');
      expect(settings.serviceTier).toBe('default');
      expect(settings.thinkingBudget).toBe('off');
    });

    it('does not overwrite when no saved values exist', () => {
      const settings: Record<string, unknown> = {
        settingsProvider: 'claude',
        model: 'haiku',
        effortLevel: 'high',
        serviceTier: 'default',
        thinkingBudget: 'off',
        savedProviderModel: {},
        savedProviderEffort: {},
        savedProviderServiceTier: {},
        savedProviderThinkingBudget: {},
      };

      ProviderSettingsCoordinator.projectActiveProviderState(settings);

      expect(settings.model).toBe('haiku');
      expect(settings.effortLevel).toBe('high');
      expect(settings.thinkingBudget).toBe('off');
    });

    it('handles missing saved maps gracefully', () => {
      const settings: Record<string, unknown> = {
        settingsProvider: 'claude',
        model: 'haiku',
        effortLevel: 'high',
        serviceTier: 'default',
        thinkingBudget: 'off',
      };

      // Should not throw
      ProviderSettingsCoordinator.projectActiveProviderState(settings);

      expect(settings.model).toBe('haiku');
    });

    it('normalizes saved effort values that the projected Claude model no longer supports', () => {
      const settings: Record<string, unknown> = {
        settingsProvider: 'claude',
        model: 'claude-sonnet-4-5',
        effortLevel: 'xhigh',
        serviceTier: 'default',
        thinkingBudget: 'off',
        savedProviderModel: { claude: 'claude-sonnet-4-5' },
        savedProviderEffort: { claude: 'xhigh' },
        savedProviderServiceTier: { claude: 'default' },
        savedProviderThinkingBudget: { claude: 'off' },
      };

      ProviderSettingsCoordinator.projectActiveProviderState(settings);

      expect(settings.model).toBe('claude-sonnet-4-5');
      expect(settings.effortLevel).toBe('high');
    });
  });

  describe('persistProjectedProviderState', () => {
    it('stores the current top-level projection for the settings provider', () => {
      const settings: Record<string, unknown> = {
        settingsProvider: 'codex',
        providerConfigs: {
          codex: { enabled: true },
        },
        model: DEFAULT_CODEX_PRIMARY_MODEL,
        effortLevel: 'low',
        serviceTier: 'fast',
        thinkingBudget: 'off',
        savedProviderModel: { claude: 'haiku' },
        savedProviderEffort: { claude: 'high' },
        savedProviderServiceTier: { claude: 'default' },
        savedProviderThinkingBudget: { claude: 'off' },
      };

      ProviderSettingsCoordinator.persistProjectedProviderState(settings);

      expect(settings.savedProviderModel).toEqual({
        claude: 'haiku',
        codex: DEFAULT_CODEX_PRIMARY_MODEL,
      });
      expect(settings.savedProviderEffort).toEqual({
        claude: 'high',
        codex: 'low',
      });
      expect(settings.savedProviderServiceTier).toEqual({
        claude: 'default',
        codex: 'fast',
      });
    });
  });

  describe('projectProviderState', () => {
    it('seeds a provider projection from provider defaults when no saved values exist', () => {
      const settings: Record<string, unknown> = {
        settingsProvider: 'claude',
        providerConfigs: {
          codex: {
            enabled: true,
            environmentVariables: '',
          },
        },
        model: 'haiku',
        effortLevel: 'high',
        serviceTier: 'default',
        thinkingBudget: 'off',
        savedProviderModel: {},
        savedProviderEffort: {},
        savedProviderServiceTier: {},
        savedProviderThinkingBudget: {},
      };

      ProviderSettingsCoordinator.projectProviderState(settings, 'codex');

      expect(settings.model).toBe('gpt-5.4-mini');
      expect(settings.effortLevel).toBe('medium');
      expect(settings.serviceTier).toBe('default');
    });

    it('preserves saved service tier when the projected model hides the toggle', () => {
      const settings: Record<string, unknown> = {
        settingsProvider: 'codex',
        providerConfigs: {
          codex: {
            enabled: true,
            environmentVariables: '',
          },
        },
        model: 'gpt-5.4-mini',
        effortLevel: 'medium',
        serviceTier: 'default',
        thinkingBudget: 'off',
        savedProviderModel: { codex: 'gpt-5.4-mini' },
        savedProviderEffort: { codex: 'medium' },
        savedProviderServiceTier: { codex: 'fast' },
        savedProviderThinkingBudget: { codex: 'off' },
      };

      ProviderSettingsCoordinator.projectProviderState(settings, 'codex');

      expect(settings.model).toBe('gpt-5.4-mini');
      expect(settings.serviceTier).toBe('fast');
    });
  });

  describe('provider-scoped reconciliation', () => {
    it('updates the inactive provider snapshot without clobbering the active projection', () => {
      const codexConv = {
        providerId: 'codex',
        sessionId: 'thread-1',
        messages: [],
      } as unknown as Conversation;

      const settings: Record<string, unknown> = {
        settingsProvider: 'claude',
        providerConfigs: {
          codex: {
            enabled: true,
            environmentVariables: `OPENAI_MODEL=${DEFAULT_CODEX_PRIMARY_MODEL}`,
          },
        },
        model: 'haiku',
        effortLevel: 'high',
        serviceTier: 'default',
        thinkingBudget: 'off',
        savedProviderModel: { claude: 'haiku', codex: DEFAULT_CODEX_PRIMARY_MODEL },
        savedProviderEffort: { claude: 'high', codex: 'medium' },
        savedProviderServiceTier: { claude: 'default', codex: 'fast' },
        savedProviderThinkingBudget: { claude: 'off', codex: 'off' },
      };

      const result = ProviderSettingsCoordinator.reconcileAllProviders(settings, [codexConv]);

      expect(result.changed).toBe(true);
      expect(codexConv.sessionId).toBeNull();
      expect(codexConv.providerState).toBeUndefined();
      expect(settings.model).toBe('haiku');
      expect(settings.savedProviderModel).toEqual({
        claude: 'haiku',
        codex: DEFAULT_CODEX_PRIMARY_MODEL,
      });
      expect(settings.savedProviderServiceTier).toEqual({
        claude: 'default',
        codex: 'fast',
      });
    });
  });
});
