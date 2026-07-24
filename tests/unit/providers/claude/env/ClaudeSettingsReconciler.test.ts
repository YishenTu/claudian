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
      expect(conversation.providerState).toEqual({
        previousProviderSessionIds: ['session-1'],
      });
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

    it('reconciles the Fable alias to its tier mapping when all tier mappings change', () => {
      const conversation = {
        providerId: 'claude',
        sessionId: 'fable-session',
        messages: [],
      } as unknown as Conversation;
      const settings: Record<string, unknown> = {
        model: 'claude-fable-5',
        providerConfigs: {
          claude: {
            environmentVariables: [
              'ANTHROPIC_DEFAULT_OPUS_MODEL=glm-5.2[1M]',
              'ANTHROPIC_DEFAULT_SONNET_MODEL=MiniMax-M3',
              'ANTHROPIC_DEFAULT_HAIKU_MODEL=DeepSeek-V4-Pro',
              'ANTHROPIC_DEFAULT_FABLE_MODEL=gpt-4.1',
            ].join('\n'),
            environmentHash: '',
          },
        },
      };

      const result = claudeSettingsReconciler.reconcileModelWithEnvironment(settings, [conversation]);

      expect(result.changed).toBe(true);
      expect(result.invalidatedConversations).toEqual([conversation]);
      expect(conversation.sessionId).toBeNull();
      expect(settings.model).toBe('claude-code/gpt-4.1');
      expect(getClaudeProviderSettings(settings).lastModel).toBe('fable');
      expect(getClaudeProviderSettings(settings).environmentHash).toBe(
        [
          'ANTHROPIC_DEFAULT_FABLE_MODEL=gpt-4.1',
          'ANTHROPIC_DEFAULT_HAIKU_MODEL=DeepSeek-V4-Pro',
          'ANTHROPIC_DEFAULT_OPUS_MODEL=glm-5.2[1M]',
          'ANTHROPIC_DEFAULT_SONNET_MODEL=MiniMax-M3',
        ].join('|'),
      );
    });

    it('preserves the Fable tier when its environment mapping changes value', () => {
      const settings: Record<string, unknown> = {
        model: 'claude-fable-5',
        providerConfigs: {
          claude: {
            lastModel: 'claude-fable-5',
            environmentVariables: [
              'ANTHROPIC_DEFAULT_OPUS_MODEL=glm-5.2[1M]',
              'ANTHROPIC_DEFAULT_SONNET_MODEL=MiniMax-M3',
              'ANTHROPIC_DEFAULT_HAIKU_MODEL=DeepSeek-V4-Pro',
              'ANTHROPIC_DEFAULT_FABLE_MODEL=gpt-4.1',
            ].join('\n'),
            environmentHash: '',
          },
        },
      };

      claudeSettingsReconciler.reconcileModelWithEnvironment(settings, []);
      claudeSettingsReconciler.normalizeModelVariantSettings(settings);

      expect(settings.model).toBe('claude-code/gpt-4.1');
      expect(getClaudeProviderSettings(settings).lastModel).toBe('fable');

      (settings.providerConfigs as Record<string, Record<string, unknown>>).claude.environmentVariables = [
        'ANTHROPIC_DEFAULT_OPUS_MODEL=glm-5.2[1M]',
        'ANTHROPIC_DEFAULT_SONNET_MODEL=MiniMax-M3',
        'ANTHROPIC_DEFAULT_HAIKU_MODEL=DeepSeek-V4-Pro',
        'ANTHROPIC_DEFAULT_FABLE_MODEL=gpt-4.2',
      ].join('\n');

      claudeSettingsReconciler.reconcileModelWithEnvironment(settings, []);

      expect(settings.model).toBe('claude-code/gpt-4.2');
      expect(getClaudeProviderSettings(settings).lastModel).toBe('fable');
    });

    it('preserves the Fable tier when its previous target becomes another tier mapping', () => {
      const settings: Record<string, unknown> = {
        model: 'claude-code/gpt-4.1',
        providerConfigs: {
          claude: {
            lastModel: 'fable',
            environmentVariables: [
              'ANTHROPIC_DEFAULT_HAIKU_MODEL=gpt-4.1',
              'ANTHROPIC_DEFAULT_FABLE_MODEL=gpt-4.2',
            ].join('\n'),
            environmentHash: [
              'ANTHROPIC_DEFAULT_FABLE_MODEL=gpt-4.1',
              'ANTHROPIC_DEFAULT_HAIKU_MODEL=DeepSeek-V4-Pro',
            ].join('|'),
          },
        },
      };

      claudeSettingsReconciler.reconcileModelWithEnvironment(settings, []);

      expect(settings.model).toBe('claude-code/gpt-4.2');
      expect(getClaudeProviderSettings(settings).lastModel).toBe('fable');
    });

    it('preserves an ANTHROPIC_MODEL selection when tier mappings also exist', () => {
      const settings: Record<string, unknown> = {
        model: 'claude-code/gpt-4.1',
        providerConfigs: {
          claude: {
            lastModel: 'fable',
            modelEnvironmentType: 'model',
            environmentVariables: [
              'ANTHROPIC_MODEL=gpt-4.2',
              'ANTHROPIC_DEFAULT_FABLE_MODEL=fable-target-2',
            ].join('\n'),
            environmentHash: [
              'ANTHROPIC_DEFAULT_FABLE_MODEL=gpt-4.1',
              'ANTHROPIC_MODEL=gpt-4.1',
            ].join('|'),
          },
        },
      };

      claudeSettingsReconciler.reconcileModelWithEnvironment(settings, []);

      expect(settings.model).toBe('claude-code/gpt-4.2');
    });

    it('preserves Fable when it previously shared a target with ANTHROPIC_MODEL', () => {
      const settings: Record<string, unknown> = {
        model: 'claude-code/gpt-4.1',
        providerConfigs: {
          claude: {
            lastModel: 'fable',
            modelEnvironmentType: 'fable',
            environmentVariables: [
              'ANTHROPIC_MODEL=gpt-4.2',
              'ANTHROPIC_DEFAULT_FABLE_MODEL=fable-target-2',
            ].join('\n'),
            environmentHash: [
              'ANTHROPIC_DEFAULT_FABLE_MODEL=gpt-4.1',
              'ANTHROPIC_MODEL=gpt-4.1',
            ].join('|'),
          },
        },
      };

      claudeSettingsReconciler.reconcileModelWithEnvironment(settings, []);

      expect(settings.model).toBe('claude-code/fable-target-2');
      expect(getClaudeProviderSettings(settings).modelEnvironmentType).toBe('fable');
    });

    it('retains explicit Fable provenance while its environment source is unavailable', () => {
      const settings: Record<string, unknown> = {
        model: 'claude-code/shared-target',
        providerConfigs: {
          claude: {
            lastModel: 'fable',
            modelEnvironmentType: 'fable',
            environmentVariables: 'ANTHROPIC_DEFAULT_HAIKU_MODEL=shared-target',
            environmentHash: 'ANTHROPIC_DEFAULT_FABLE_MODEL=shared-target',
          },
        },
      };

      claudeSettingsReconciler.reconcileModelWithEnvironment(settings, []);

      expect(settings.model).toBe('claude-code/shared-target');
      expect(getClaudeProviderSettings(settings)).toMatchObject({
        lastModel: 'fable',
        modelEnvironmentType: 'fable',
      });

      (settings.providerConfigs as Record<string, Record<string, unknown>>).claude.environmentVariables = [
        'ANTHROPIC_DEFAULT_HAIKU_MODEL=haiku-target-2',
        'ANTHROPIC_DEFAULT_FABLE_MODEL=fable-target-2',
      ].join('\n');

      claudeSettingsReconciler.reconcileModelWithEnvironment(settings, []);

      expect(settings.model).toBe('claude-code/fable-target-2');
      expect(getClaudeProviderSettings(settings).modelEnvironmentType).toBe('fable');
    });

    it('remaps an environment-derived Fable title model independently', () => {
      const settings: Record<string, unknown> = {
        model: 'claude-code/custom-haiku',
        titleGenerationModel: 'claude-code/gpt-4.1',
        providerConfigs: {
          claude: {
            lastModel: 'haiku',
            modelEnvironmentType: 'haiku',
            titleModelEnvironmentType: 'fable',
            environmentVariables: [
              'ANTHROPIC_DEFAULT_HAIKU_MODEL=custom-haiku',
              'ANTHROPIC_DEFAULT_FABLE_MODEL=gpt-4.2',
            ].join('\n'),
            environmentHash: [
              'ANTHROPIC_DEFAULT_FABLE_MODEL=gpt-4.1',
              'ANTHROPIC_DEFAULT_HAIKU_MODEL=custom-haiku',
            ].join('|'),
          },
        },
      };

      claudeSettingsReconciler.reconcileModelWithEnvironment(settings, []);

      expect(settings.model).toBe('claude-code/custom-haiku');
      expect(settings.titleGenerationModel).toBe('claude-code/gpt-4.2');
      expect(getClaudeProviderSettings(settings).titleModelEnvironmentType).toBe('fable');
    });

    it('infers legacy Fable provenance from the old hash after startup normalization', () => {
      const settings: Record<string, unknown> = {
        model: 'claude-code/shared-target',
        titleGenerationModel: 'claude-code/shared-target',
        providerConfigs: {
          claude: {
            lastModel: 'fable',
            environmentVariables: [
              'ANTHROPIC_DEFAULT_HAIKU_MODEL=shared-target',
              'ANTHROPIC_DEFAULT_FABLE_MODEL=fable-new',
            ].join('\n'),
            environmentHash: 'ANTHROPIC_DEFAULT_FABLE_MODEL=shared-target',
          },
        },
      };

      claudeSettingsReconciler.normalizeModelVariantSettings(settings);

      expect(settings.model).toBe('claude-code/fable-new');
      expect(settings.titleGenerationModel).toBe('claude-code/fable-new');
      expect(getClaudeProviderSettings(settings)).toMatchObject({
        modelEnvironmentType: 'fable',
        titleModelEnvironmentType: 'fable',
      });

      claudeSettingsReconciler.reconcileModelWithEnvironment(settings, []);

      expect(settings.model).toBe('claude-code/fable-new');
      expect(settings.titleGenerationModel).toBe('claude-code/fable-new');
      expect(getClaudeProviderSettings(settings)).toMatchObject({
        lastModel: 'fable',
        modelEnvironmentType: 'fable',
        titleModelEnvironmentType: 'fable',
      });
    });

    it('preserves an environment-derived concrete Fable selection during reconciliation', () => {
      const settings: Record<string, unknown> = {
        model: 'claude-fable-5',
        providerConfigs: {
          claude: {
            environmentVariables: [
              'ANTHROPIC_DEFAULT_HAIKU_MODEL=custom-haiku',
              'ANTHROPIC_DEFAULT_FABLE_MODEL=claude-fable-5',
            ].join('\n'),
            environmentHash: '',
          },
        },
      };

      const result = claudeSettingsReconciler.reconcileModelWithEnvironment(settings, []);

      expect(result.changed).toBe(true);
      expect(settings.model).toBe('claude-code/claude-fable-5');
    });
  });

  describe('normalizeModelVariantSettings', () => {
    it('does not infer environment provenance for pristine built-in defaults', () => {
      const settings: Record<string, unknown> = {
        settingsProvider: 'claude',
        model: 'haiku',
        titleGenerationModel: '',
        providerConfigs: {
          claude: {
            lastModel: 'haiku',
            modelEnvironmentType: '',
            titleModelEnvironmentType: '',
            environmentVariables: '',
            environmentHash: '',
          },
        },
      };

      expect(claudeSettingsReconciler.normalizeModelVariantSettings(settings)).toBe(false);
      expect(getClaudeProviderSettings(settings)).toMatchObject({
        modelEnvironmentType: '',
        titleModelEnvironmentType: '',
      });
    });

    it('uses source ownership when a different tier target is a Fable alias', () => {
      const settings: Record<string, unknown> = {
        settingsProvider: 'claude',
        model: 'claude-code/gpt-4.1',
        titleGenerationModel: 'claude-code/gpt-4.1',
        providerConfigs: {
          claude: {
            lastModel: 'fable',
            modelEnvironmentType: 'fable',
            titleModelEnvironmentType: 'fable',
            environmentVariables: [
              'ANTHROPIC_DEFAULT_HAIKU_MODEL=fable',
              'ANTHROPIC_DEFAULT_FABLE_MODEL=gpt-4.1',
            ].join('\n'),
            environmentHash: [
              'ANTHROPIC_DEFAULT_FABLE_MODEL=gpt-4.1',
              'ANTHROPIC_DEFAULT_HAIKU_MODEL=fable',
            ].join('|'),
          },
        },
      };

      expect(claudeSettingsReconciler.normalizeModelVariantSettings(settings)).toBe(false);
      expect(settings.model).toBe('claude-code/gpt-4.1');
      expect(settings.titleGenerationModel).toBe('claude-code/gpt-4.1');
    });

    it('prefers exact environment ownership over an unqualified legacy Fable alias', () => {
      const settings: Record<string, unknown> = {
        settingsProvider: 'claude',
        model: 'claude-fable-5',
        titleGenerationModel: 'claude-fable-5',
        providerConfigs: {
          claude: {
            lastModel: 'fable',
            environmentVariables: 'ANTHROPIC_DEFAULT_HAIKU_MODEL=claude-fable-5',
            environmentHash: 'ANTHROPIC_DEFAULT_HAIKU_MODEL=claude-fable-5',
          },
        },
      };

      expect(claudeSettingsReconciler.normalizeModelVariantSettings(settings)).toBe(true);
      expect(settings.model).toBe('claude-code/claude-fable-5');
      expect(settings.titleGenerationModel).toBe('claude-code/claude-fable-5');
      expect(getClaudeProviderSettings(settings)).toMatchObject({
        modelEnvironmentType: 'haiku',
        titleModelEnvironmentType: 'haiku',
      });
    });

    it('uses the historical hash before an old Fable target disappears', () => {
      const settings: Record<string, unknown> = {
        settingsProvider: 'claude',
        model: 'claude-code/gpt-4.1',
        titleGenerationModel: 'claude-code/gpt-4.1',
        providerConfigs: {
          claude: {
            lastModel: 'fable',
            environmentVariables: [
              'ANTHROPIC_DEFAULT_HAIKU_MODEL=custom-haiku',
              'ANTHROPIC_DEFAULT_FABLE_MODEL=gpt-4.2',
            ].join('\n'),
            environmentHash: 'ANTHROPIC_DEFAULT_FABLE_MODEL=gpt-4.1',
          },
        },
      };

      expect(claudeSettingsReconciler.normalizeModelVariantSettings(settings)).toBe(true);
      expect(settings.model).toBe('claude-code/gpt-4.2');
      expect(settings.titleGenerationModel).toBe('claude-code/gpt-4.2');
      expect(getClaudeProviderSettings(settings)).toMatchObject({
        modelEnvironmentType: 'fable',
        titleModelEnvironmentType: 'fable',
      });
    });

    it('remaps a persisted Fable title before global title validation runs', () => {
      const settings: Record<string, unknown> = {
        model: 'claude-code/custom-haiku',
        titleGenerationModel: 'claude-code/gpt-4.1',
        providerConfigs: {
          claude: {
            lastModel: 'haiku',
            modelEnvironmentType: 'haiku',
            titleModelEnvironmentType: 'fable',
            environmentVariables: [
              'ANTHROPIC_DEFAULT_HAIKU_MODEL=custom-haiku',
              'ANTHROPIC_DEFAULT_FABLE_MODEL=gpt-4.2',
            ].join('\n'),
          },
        },
      };

      expect(claudeSettingsReconciler.normalizeModelVariantSettings(settings)).toBe(true);
      expect(settings.titleGenerationModel).toBe('claude-code/gpt-4.2');
      expect(getClaudeProviderSettings(settings).titleModelEnvironmentType).toBe('fable');
    });

    it('migrates legacy built-in 1M aliases across Claude model settings', () => {
      const settings: Record<string, unknown> = {
        model: 'claude-code/opus[1m]',
        titleGenerationModel: 'sonnet[1M]',
        providerConfigs: {
          claude: {
            lastModel: 'opus[1M]',
          },
        },
      };

      expect(claudeSettingsReconciler.normalizeModelVariantSettings(settings)).toBe(true);
      expect(settings.model).toBe('opus');
      expect(settings.titleGenerationModel).toBe('sonnet');
      expect(getClaudeProviderSettings(settings).lastModel).toBe('opus');
    });

    it('migrates the legacy concrete Fable model to the SDK alias', () => {
      const settings: Record<string, unknown> = {
        model: 'claude-fable-5',
        titleGenerationModel: 'claude-fable-5',
        providerConfigs: {
          claude: {
            lastModel: 'claude-fable-5',
          },
        },
      };

      expect(claudeSettingsReconciler.normalizeModelVariantSettings(settings)).toBe(true);
      expect(settings.model).toBe('fable');
      expect(settings.titleGenerationModel).toBe('fable');
      expect(getClaudeProviderSettings(settings).lastModel).toBe('fable');
    });

    it('preserves concrete Fable selections while retaining the tier preference', () => {
      const concreteSelection = 'claude-code/claude-fable-5';
      const settings: Record<string, unknown> = {
        model: concreteSelection,
        titleGenerationModel: concreteSelection,
        providerConfigs: {
          claude: {
            lastModel: concreteSelection,
            environmentVariables: 'ANTHROPIC_DEFAULT_FABLE_MODEL=claude-fable-5',
          },
        },
      };

      expect(claudeSettingsReconciler.normalizeModelVariantSettings(settings)).toBe(true);
      expect(settings.model).toBe(concreteSelection);
      expect(settings.titleGenerationModel).toBe(concreteSelection);
      expect(getClaudeProviderSettings(settings).lastModel).toBe('fable');
    });
  });
});
