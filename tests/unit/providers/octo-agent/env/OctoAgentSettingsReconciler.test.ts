import type { Conversation } from '@/core/types';
import { octoAgentSettingsReconciler } from '@/providers/octo-agent/env/OctoAgentSettingsReconciler';

describe('octoAgentSettingsReconciler', () => {
  describe('normalizeModelVariantSettings', () => {
    it('returns false and leaves non-octo-agent models untouched', () => {
      const settings: Record<string, unknown> = { model: 'claude-code/claude-sonnet-4-5' };
      expect(octoAgentSettingsReconciler.normalizeModelVariantSettings(settings)).toBe(false);
      expect(settings.model).toBe('claude-code/claude-sonnet-4-5');
    });

    it('returns false when the octo-agent model is already valid', () => {
      const settings: Record<string, unknown> = { model: 'octo-agent/kimi-for-coding' };
      expect(octoAgentSettingsReconciler.normalizeModelVariantSettings(settings)).toBe(false);
      expect(settings.model).toBe('octo-agent/kimi-for-coding');
    });

    it('normalizes an invalid octo-agent model to the default and reports changed', () => {
      const settings: Record<string, unknown> = {
        model: 'octo-agent/unknown',
        octoAgentModels: [
          { value: 'octo-agent/kimi-for-coding', label: 'Kimi' },
        ],
      };
      expect(octoAgentSettingsReconciler.normalizeModelVariantSettings(settings)).toBe(true);
      expect(settings.model).toBe('octo-agent/kimi-for-coding');
    });
  });

  describe('reconcileModelWithEnvironment', () => {
    it('invalidates octo-agent conversations when the provider is disabled', () => {
      const settings: Record<string, unknown> = {
        providerConfigs: { 'octo-agent': { enabled: false } },
      };
      const conversation: Conversation = {
        id: 'c1',
        providerId: 'octo-agent',
        sessionId: 's1',
        providerState: { sessionId: 's1' },
      } as unknown as Conversation;

      const result = octoAgentSettingsReconciler.reconcileModelWithEnvironment(settings, [conversation]);

      expect(result.changed).toBe(true);
      expect(conversation.sessionId).toBeNull();
      expect(conversation.providerState).toBeUndefined();
    });

    it('does nothing when the provider is enabled', () => {
      const settings: Record<string, unknown> = {
        providerConfigs: { 'octo-agent': { enabled: true } },
      };
      const conversation: Conversation = {
        id: 'c1',
        providerId: 'octo-agent',
        sessionId: 's1',
      } as unknown as Conversation;

      const result = octoAgentSettingsReconciler.reconcileModelWithEnvironment(settings, [conversation]);

      expect(result.changed).toBe(false);
      expect(conversation.sessionId).toBe('s1');
    });
  });
});
