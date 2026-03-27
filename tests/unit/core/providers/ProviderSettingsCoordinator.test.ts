import { ProviderRegistry } from '@/core/providers';
import { ProviderSettingsCoordinator } from '@/core/providers/ProviderSettingsCoordinator';
import type { Conversation } from '@/core/types';

describe('ProviderSettingsCoordinator', () => {
  describe('normalizeProviderSelection', () => {
    it('falls back to claude when codex is disabled', () => {
      const settings: Record<string, unknown> = {
        activeProvider: 'codex',
        codexEnabled: false,
      };

      const changed = ProviderSettingsCoordinator.normalizeProviderSelection(settings);

      expect(changed).toBe(true);
      expect(settings.activeProvider).toBe('claude');
    });

    it('falls back to claude for unknown providers', () => {
      const settings: Record<string, unknown> = {
        activeProvider: 'mystery-provider',
        codexEnabled: true,
      };

      const changed = ProviderSettingsCoordinator.normalizeProviderSelection(settings);

      expect(changed).toBe(true);
      expect(settings.activeProvider).toBe('claude');
    });
  });

  describe('reconcileAllProviders', () => {
    it('delegates to each registered provider reconciler with its own conversations', () => {
      const settings: Record<string, unknown> = { model: 'haiku' };
      const claudeConv = { providerId: 'claude', messages: [] } as unknown as Conversation;
      const conversations = [claudeConv];

      const result = ProviderSettingsCoordinator.reconcileAllProviders(settings, conversations, '');

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

      ProviderSettingsCoordinator.reconcileAllProviders(settings, [claudeConv, otherConv], '');

      // Claude reconciler should only receive claude conversations
      expect(reconcileSpy).toHaveBeenCalledWith(
        settings,
        [claudeConv],
        '',
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
  });

  describe('projectActiveProviderState', () => {
    it('projects saved model/effort/budget for the active provider', () => {
      const settings: Record<string, unknown> = {
        activeProvider: 'codex',
        model: 'haiku',
        effortLevel: 'high',
        thinkingBudget: 'off',
        savedProviderModel: { codex: 'codex-mini', claude: 'haiku' },
        savedProviderEffort: { codex: 'medium', claude: 'high' },
        savedProviderThinkingBudget: { codex: '1024', claude: 'off' },
      };

      ProviderSettingsCoordinator.projectActiveProviderState(settings);

      expect(settings.model).toBe('codex-mini');
      expect(settings.effortLevel).toBe('medium');
      expect(settings.thinkingBudget).toBe('1024');
    });

    it('defaults to claude when activeProvider is not set', () => {
      const settings: Record<string, unknown> = {
        model: 'old-model',
        effortLevel: 'low',
        thinkingBudget: '500',
        savedProviderModel: { claude: 'sonnet' },
        savedProviderEffort: { claude: 'high' },
        savedProviderThinkingBudget: { claude: 'off' },
      };

      ProviderSettingsCoordinator.projectActiveProviderState(settings);

      expect(settings.model).toBe('sonnet');
      expect(settings.effortLevel).toBe('high');
      expect(settings.thinkingBudget).toBe('off');
    });

    it('does not overwrite when no saved values exist', () => {
      const settings: Record<string, unknown> = {
        activeProvider: 'claude',
        model: 'haiku',
        effortLevel: 'high',
        thinkingBudget: 'off',
        savedProviderModel: {},
        savedProviderEffort: {},
        savedProviderThinkingBudget: {},
      };

      ProviderSettingsCoordinator.projectActiveProviderState(settings);

      expect(settings.model).toBe('haiku');
      expect(settings.effortLevel).toBe('high');
      expect(settings.thinkingBudget).toBe('off');
    });

    it('handles missing saved maps gracefully', () => {
      const settings: Record<string, unknown> = {
        activeProvider: 'claude',
        model: 'haiku',
        effortLevel: 'high',
        thinkingBudget: 'off',
      };

      // Should not throw
      ProviderSettingsCoordinator.projectActiveProviderState(settings);

      expect(settings.model).toBe('haiku');
    });
  });

  describe('persistProjectedProviderState', () => {
    it('stores the current top-level projection for the active provider', () => {
      const settings: Record<string, unknown> = {
        activeProvider: 'codex',
        model: 'gpt-4.1',
        effortLevel: 'low',
        thinkingBudget: 'off',
        savedProviderModel: { claude: 'haiku' },
        savedProviderEffort: { claude: 'high' },
        savedProviderThinkingBudget: { claude: 'off' },
      };

      ProviderSettingsCoordinator.persistProjectedProviderState(settings);

      expect(settings.savedProviderModel).toEqual({
        claude: 'haiku',
        codex: 'gpt-4.1',
      });
      expect(settings.savedProviderEffort).toEqual({
        claude: 'high',
        codex: 'low',
      });
    });
  });

  describe('projectProviderState', () => {
    it('seeds a provider projection from provider defaults when no saved values exist', () => {
      const settings: Record<string, unknown> = {
        activeProvider: 'claude',
        environmentVariables: '',
        model: 'haiku',
        effortLevel: 'high',
        thinkingBudget: 'off',
        savedProviderModel: {},
        savedProviderEffort: {},
        savedProviderThinkingBudget: {},
      };

      ProviderSettingsCoordinator.projectProviderState(settings, 'codex');

      expect(settings.model).toBe('codex-mini');
      expect(settings.effortLevel).toBe('medium');
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
        activeProvider: 'claude',
        model: 'haiku',
        effortLevel: 'high',
        thinkingBudget: 'off',
        savedProviderModel: { claude: 'haiku', codex: 'codex-mini' },
        savedProviderEffort: { claude: 'high', codex: 'medium' },
        savedProviderThinkingBudget: { claude: 'off', codex: 'off' },
      };

      const result = ProviderSettingsCoordinator.reconcileAllProviders(
        settings,
        [codexConv],
        'OPENAI_MODEL=gpt-4.1',
      );

      expect(result.changed).toBe(true);
      expect(codexConv.sessionId).toBeNull();
      expect(codexConv.providerState).toBeUndefined();
      expect(settings.model).toBe('haiku');
      expect(settings.savedProviderModel).toEqual({
        claude: 'haiku',
        codex: 'gpt-4.1',
      });
    });
  });
});
