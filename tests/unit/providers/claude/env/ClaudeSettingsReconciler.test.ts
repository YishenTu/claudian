import { isVersionedRuntimeInputFingerprint } from '@/core/providers/settings/RuntimeInputFingerprint';
import type { Conversation } from '@/core/types';
import { claudeSettingsReconciler } from '@/providers/claude/env/ClaudeSettingsReconciler';
import { getClaudeProviderSettings } from '@/providers/claude/settings';

describe('claudeSettingsReconciler', () => {
  it.each(['CLAUDE_CONFIG_DIR', 'HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH'])('invalidates native bindings when configured %s changes or is removed', key => {
    const settings: Record<string, unknown> = {
      providerConfigs: { claude: { enabled: true, environmentVariables: `${key}=/old-home` } },
    };
    claudeSettingsReconciler.reconcileModelWithEnvironment(settings, []);
    const conversation = { providerId: 'claude', sessionId: 'native-session', messages: [] } as unknown as Conversation;
    for (const nextEnvironment of [`${key}=/new-home`, '']) {
      (settings.providerConfigs as any).claude.environmentVariables = nextEnvironment;
      conversation.sessionId = 'native-session';
      const result = claudeSettingsReconciler.reconcileModelWithEnvironment(settings, [conversation]);
      expect(result).toMatchObject({ changed: true, invalidatedConversations: [conversation] });
      expect(conversation.sessionId).toBeNull();
    }
  });

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
            environmentVariables: 'ANTHROPIC_BASE_URL=https://api.example.com',
            environmentHash: '',
          },
        },
      };

      const result = claudeSettingsReconciler.reconcileModelWithEnvironment(settings, [conversation]);

      expect(result.changed).toBe(true);
      expect(result.invalidatedConversations).toEqual([conversation]);
      expect(conversation.sessionId).toBeNull();
      expect(conversation.providerState).toEqual({
        previousProviderSessionIds: ['session-1'],
      });
      expect(settings.model).toBe('claude-opus-4-6');
      const fingerprint = getClaudeProviderSettings(settings).environmentHash;
      expect(isVersionedRuntimeInputFingerprint(fingerprint)).toBe(true);
      expect(fingerprint).not.toContain('https://api.example.com');
    });

    it('preserves an unavailable saved model instead of choosing a fallback', () => {
      const settings: Record<string, unknown> = {
        settingsProvider: 'claude',
        model: 'claude-opus-4-6',
        providerConfigs: {
          claude: {
            customModels: '',
            environmentVariables: 'ANTHROPIC_BASE_URL=https://api.example.com',
            environmentHash: '',
          },
        },
      };

      const result = claudeSettingsReconciler.reconcileModelWithEnvironment(settings, []);

      expect(result.changed).toBe(true);
      expect(settings.model).toBe('claude-opus-4-6');
    });

    it('invalidates only Claude conversations and preserves Claude transcript references', () => {
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
      expect(claudeConversation.resumeAtMessageId).toBe('assistant-1');
      expect(claudeConversation.providerState).toEqual({
        previousProviderSessionIds: ['previous-session', 'provider-session'],
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
      expect(conversation.providerState).toEqual({
        previousProviderSessionIds: ['provider-session'],
      });
    });

    it('preserves transcript session ids when invalidating resumable Claude state', () => {
      const conversation = {
        id: 'claude-history-backed',
        providerId: 'claude',
        sessionId: 'legacy-session',
        resumeAtMessageId: 'assistant-checkpoint',
        providerState: {
          providerSessionId: 'current-provider-session',
          previousProviderSessionIds: ['previous-provider-session'],
          subagentData: { task: { id: 'task' } },
        },
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

      const first = claudeSettingsReconciler.reconcileModelWithEnvironment(
        settings,
        [conversation],
      );
      const second = claudeSettingsReconciler.invalidateConversationSessions([conversation]);

      expect(first.invalidatedConversations).toEqual([conversation]);
      expect(second).toEqual([]);
      expect(conversation).toMatchObject({
        sessionId: null,
        resumeAtMessageId: 'assistant-checkpoint',
        providerState: {
          previousProviderSessionIds: [
            'previous-provider-session',
            'current-provider-session',
          ],
          subagentData: { task: { id: 'task' } },
        },
      });
      expect(conversation.providerState).not.toHaveProperty('providerSessionId');
    });

    it('converts a pending fork into replayable history at the fork checkpoint', () => {
      const conversation = {
        id: 'pending-fork',
        providerId: 'claude',
        sessionId: null,
        providerState: {
          forkSource: {
            sessionId: 'fork-source-session',
            resumeAt: 'fork-source-checkpoint',
          },
        },
        messages: [],
      } as unknown as Conversation;

      const invalidated = claudeSettingsReconciler.invalidateConversationSessions([conversation]);

      expect(invalidated).toEqual([conversation]);
      expect(conversation).toMatchObject({
        sessionId: null,
        resumeAtMessageId: 'fork-source-checkpoint',
        providerState: {
          previousProviderSessionIds: ['fork-source-session'],
        },
      });
      expect(conversation.providerState).not.toHaveProperty('forkSource');
    });

  });

  describe('normalizeModelVariantSettings', () => {
    it('migrates a current legacy fingerprint without treating inputs as changed', () => {
      const settings: Record<string, unknown> = {
        model: 'sonnet',
        providerConfigs: {
          claude: {
            environmentHash: 'ANTHROPIC_BASE_URL=https://same.example.com',
            environmentVariables: 'ANTHROPIC_BASE_URL=https://same.example.com',
          },
        },
      };

      expect(claudeSettingsReconciler.normalizeModelVariantSettings(settings)).toBe(true);
      expect(isVersionedRuntimeInputFingerprint(
        getClaudeProviderSettings(settings).environmentHash,
      )).toBe(true);
      expect(claudeSettingsReconciler.reconcileModelWithEnvironment(settings, []))
        .toEqual({ changed: false, invalidatedConversations: [] });
    });


  });
});
