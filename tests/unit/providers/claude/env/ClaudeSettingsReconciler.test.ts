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
      expect(settings.model).toBe('claude-code/claude-opus-4-6');
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

    it('invalidates only Claude conversations and clears every Claude-owned resume field', () => {
      const claudeConversation = {
        id: 'claude-conversation',
        providerId: 'claude',
        sessionId: 'legacy-session',
        resumeAtMessageId: 'assistant-1',
        providerState: {
          providerSessionId: 'provider-session',
          previousProviderSessionIds: ['previous-session'],
          forkSource: { sessionId: 'source-session', resumeAt: 'assistant-0' },
          subagentData: { task: { id: 'task' } },
          uiMetadata: { keep: true },
        },
        messages: [{ id: 'message', role: 'user', content: 'Keep me', timestamp: 1 }],
      } as unknown as Conversation;
      const codexConversation = {
        id: 'codex-conversation',
        providerId: 'codex',
        sessionId: 'codex-session',
        providerState: { threadId: 'codex-thread' },
        messages: [],
      } as unknown as Conversation;
      const settings: Record<string, unknown> = {
        model: 'sonnet',
        providerConfigs: {
          claude: {
            environmentVariables: 'ANTHROPIC_BASE_URL=https://api.example.com',
            environmentHash: '',
          },
        },
      };

      const result = claudeSettingsReconciler.reconcileModelWithEnvironment(
        settings,
        [claudeConversation, codexConversation],
      );

      expect(result.invalidatedConversations).toEqual([claudeConversation]);
      expect(claudeConversation.sessionId).toBeNull();
      expect(claudeConversation.resumeAtMessageId).toBeUndefined();
      expect(claudeConversation.providerState).toEqual({
        subagentData: { task: { id: 'task' } },
        uiMetadata: { keep: true },
      });
      expect(claudeConversation.messages).toHaveLength(1);
      expect(codexConversation).toMatchObject({
        sessionId: 'codex-session',
        providerState: { threadId: 'codex-thread' },
      });
    });

    it('invalidates Claude provider resume state even when the generic session id is absent', () => {
      const conversation = {
        id: 'claude-provider-state-only',
        providerId: 'claude',
        sessionId: null,
        providerState: { providerSessionId: 'provider-session' },
        messages: [],
      } as unknown as Conversation;
      const settings: Record<string, unknown> = {
        model: 'sonnet',
        providerConfigs: {
          claude: {
            environmentVariables: 'ANTHROPIC_BASE_URL=https://api.example.com',
            environmentHash: '',
          },
        },
      };

      const result = claudeSettingsReconciler.reconcileModelWithEnvironment(settings, [conversation]);

      expect(result.invalidatedConversations).toEqual([conversation]);
      expect(conversation.providerState).toBeUndefined();
    });
  });
});
