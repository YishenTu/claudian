import type { Conversation } from '@/core/types';
import { claudeSettingsReconciler } from '@/providers/claude/env/ClaudeSettingsReconciler';
import { getClaudeProviderSettings } from '@/providers/claude/settings';

describe('claudeSettingsReconciler', () => {
  describe('reconcileModelWithEnvironment', () => {
    it('preserves an active settings-defined custom model across non-model env changes', () => {
      const conversation = {
        providerId: 'claude',
        sessionId: 'session-1',
        messages: [],
      } as unknown as Conversation;
      const settings: Record<string, unknown> = {
        settingsProvider: 'claude',
        model: 'claude-opus-4-6',
        providerConfigs: {
          claude: {
            customModels: 'claude-opus-4-6',
            lastModel: 'sonnet',
            environmentVariables: 'ANTHROPIC_BASE_URL=https://api.example.com',
            environmentHash: '',
          },
        },
      };

      const result = claudeSettingsReconciler.reconcileModelWithEnvironment(settings, [conversation]);

      expect(result.changed).toBe(true);
      expect(result.invalidatedConversations).toEqual([conversation]);
      expect(conversation.sessionId).toBeNull();
      expect(settings.model).toBe('claude-opus-4-6');
      expect(getClaudeProviderSettings(settings).environmentHash).toBe(
        'ANTHROPIC_BASE_URL=https://api.example.com',
      );
    });

    it('falls back to the saved built-in model when a removed custom model is no longer valid', () => {
      const settings: Record<string, unknown> = {
        settingsProvider: 'claude',
        model: 'claude-opus-4-6',
        providerConfigs: {
          claude: {
            customModels: '',
            lastModel: 'sonnet',
            environmentVariables: 'ANTHROPIC_BASE_URL=https://api.example.com',
            environmentHash: '',
          },
        },
      };

      const result = claudeSettingsReconciler.reconcileModelWithEnvironment(settings, []);

      expect(result.changed).toBe(true);
      expect(settings.model).toBe('sonnet');
    });
  });
});
