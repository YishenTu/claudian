import '@/providers';

import { TEST_CODEX_CATALOG, TEST_CODEX_MODEL } from '@test/helpers/codexModels';

import { getProviderSettingsSnapshotWithModel } from '@/core/providers/conversationModel';
import { ProviderRegistry } from '@/core/providers/ProviderRegistry';
import { ProviderSettingsCoordinator } from '@/core/providers/ProviderSettingsCoordinator';
import type { Conversation } from '@/core/types';
import { DEFAULT_CLAUDE_PROVIDER_SETTINGS } from '@/providers/claude/settings';

describe('ProviderSettingsCoordinator', () => {
  describe('conversation model projection', () => {
    it('preserves a valid explicit reasoning choice when reading an existing conversation', () => {
      const settings: Record<string, unknown> = {
        settingsProvider: 'codex',
        model: TEST_CODEX_MODEL,
        effortLevel: 'low',
        serviceTier: 'default',
        savedProviderModel: { codex: TEST_CODEX_MODEL },
        savedProviderEffort: { codex: 'low' },
        providerConfigs: {
          codex: {
            enabled: true,
            discoveredModels: TEST_CODEX_CATALOG,
          },
        },
      };

      const snapshot = getProviderSettingsSnapshotWithModel(
        settings,
        'codex',
        TEST_CODEX_MODEL,
      );

      expect(snapshot.effortLevel).toBe('low');
      expect(settings.effortLevel).toBe('low');
    });

    it('uses a Pi conversation model preference before normalizing against the saved provider model', () => {
      const deepSeekModel = 'pi:deepseek/deepseek-reasoner';
      const gptModel = 'pi:openai/gpt-5';
      const settings: Record<string, unknown> = {
        effortLevel: 'minimal',
        model: deepSeekModel,
        providerConfigs: {
          pi: {
            discoveredModels: [
              {
                encodedId: deepSeekModel,
                id: 'deepseek-reasoner',
                input: ['text'],
                label: 'DeepSeek Reasoner',
                provider: 'deepseek',
                reasoning: true,
                thinkingLevels: ['off', 'high'],
              },
              {
                encodedId: gptModel,
                id: 'gpt-5',
                input: ['text'],
                label: 'GPT-5',
                provider: 'openai',
                reasoning: true,
                thinkingLevels: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'],
              },
            ],
            enabled: true,
            preferredThinkingByModel: {
              [deepSeekModel]: 'high',
              [gptModel]: 'minimal',
            },
            visibleModels: [deepSeekModel, gptModel],
          },
        },
        savedProviderEffort: { pi: 'minimal' },
        savedProviderModel: { pi: deepSeekModel },
        serviceTier: 'default',
        settingsProvider: 'pi',
      };

      const snapshot = getProviderSettingsSnapshotWithModel(settings, 'pi', gptModel);

      expect(snapshot.model).toBe(gptModel);
      expect(snapshot.effortLevel).toBe('minimal');
    });
  });

  describe('applyModelSelection', () => {
    it('clamps reasoning and service tier values to the selected model metadata', () => {
      const settings: Record<string, unknown> = {
        model: TEST_CODEX_MODEL,
        effortLevel: 'unsupported',
        serviceTier: 'priority',
        providerConfigs: {
          codex: {
            enabled: true,
            discoveredModels: TEST_CODEX_CATALOG,
          },
        },
      };

      ProviderSettingsCoordinator.applyModelSelection(settings, 'codex', 'gpt-5.4-mini');

      expect(settings.model).toBe('gpt-5.4-mini');
      expect(settings.effortLevel).toBe('medium');
      expect(settings.serviceTier).toBe('default');
    });

    it('applies high as the default when switching to a Codex model that supports it', () => {
      const settings: Record<string, unknown> = {
        model: 'gpt-5.4-mini',
        effortLevel: 'low',
        serviceTier: 'default',
        providerConfigs: {
          codex: {
            enabled: true,
            discoveredModels: TEST_CODEX_CATALOG,
          },
        },
      };

      ProviderSettingsCoordinator.applyModelSelection(settings, 'codex', TEST_CODEX_MODEL);

      expect(settings.effortLevel).toBe('high');
    });
  });

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
          codex: { enabled: true, discoveredModels: TEST_CODEX_CATALOG },
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

  describe('applyProviderEnablement', () => {
    it('atomically disables a provider and clears dependent shared selections', () => {
      const settings: Record<string, unknown> = {
        settingsProvider: 'codex',
        titleGenerationModel: TEST_CODEX_MODEL,
        providerConfigs: {
          codex: {
            discoveredModels: TEST_CODEX_CATALOG,
            enabled: true,
          },
        },
      };

      ProviderSettingsCoordinator.applyProviderEnablement(settings, 'codex', false);

      expect(ProviderRegistry.isEnabled('codex', settings)).toBe(false);
      expect(settings.settingsProvider).toBe('claude');
      expect(settings.titleGenerationModel).toBe('');
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
          codex: { enabled: true, discoveredModels: TEST_CODEX_CATALOG },
        },
        savedProviderModel: { codex: 'gpt-5.4' },
      };

      expect(ProviderSettingsCoordinator.normalizeAllModelVariants(settings)).toBe(true);
      expect(settings.model).toBe(TEST_CODEX_MODEL);
      expect(settings.savedProviderModel).toEqual({ codex: TEST_CODEX_MODEL });
    });
  });

  describe('reconcileTitleGenerationModelSelection', () => {
    it('persists Claude environment provenance when selecting a title model', () => {
      const settings: Record<string, unknown> = {
        titleGenerationModel: '',
        providerConfigs: {
          claude: {
            ...DEFAULT_CLAUDE_PROVIDER_SETTINGS,
            environmentVariables: 'ANTHROPIC_DEFAULT_FABLE_MODEL=gpt-4.1',
          },
        },
      };

      ProviderSettingsCoordinator.applyTitleGenerationModelSelection(
        settings,
        'claude-code/gpt-4.1',
      );

      expect(settings.titleGenerationModel).toBe('claude-code/gpt-4.1');
      expect((settings.providerConfigs as Record<string, Record<string, unknown>>).claude)
        .toMatchObject({ titleModelEnvironmentType: 'fable' });
    });

    it('migrates available Claude custom title models to provider-qualified ids', () => {
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
      ).toBe(true);
      expect(settings.titleGenerationModel).toBe('claude-code/claude-opus-4-6');
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

    it('clears stale provider-qualified custom title models instead of retargeting to a fallback', () => {
      const settings: Record<string, unknown> = {
        titleGenerationModel: 'openai-codex/my-custom-model',
        providerConfigs: {
          codex: {
            enabled: true,
            customModels: '',
          },
        },
      };

      expect(
        ProviderSettingsCoordinator.reconcileTitleGenerationModelSelection(settings),
      ).toBe(true);
      expect(settings.titleGenerationModel).toBe('');
    });

    it('clears title models owned by a disabled provider', () => {
      const settings: Record<string, unknown> = {
        titleGenerationModel: TEST_CODEX_MODEL,
        providerConfigs: {
          codex: {
            discoveredModels: TEST_CODEX_CATALOG,
            enabled: false,
          },
        },
      };

      expect(
        ProviderSettingsCoordinator.reconcileTitleGenerationModelSelection(settings),
      ).toBe(true);
      expect(settings.titleGenerationModel).toBe('');
    });

    it('migrates available Codex custom title models to provider-qualified ids', () => {
      const settings: Record<string, unknown> = {
        titleGenerationModel: 'my-custom-model',
        providerConfigs: {
          codex: {
            enabled: true,
            customModels: 'my-custom-model',
          },
        },
      };

      expect(
        ProviderSettingsCoordinator.reconcileTitleGenerationModelSelection(settings),
      ).toBe(true);
      expect(settings.titleGenerationModel).toBe('openai-codex/my-custom-model');
    });
  });

  describe('Claude environment reconciliation', () => {
    it('preserves Fable provenance while projecting an inactive Claude provider', () => {
      const settings: Record<string, unknown> = {
        settingsProvider: 'codex',
        model: TEST_CODEX_MODEL,
        effortLevel: 'high',
        serviceTier: 'default',
        thinkingBudget: 'off',
        savedProviderModel: {
          claude: 'claude-code/fable-v1',
          codex: TEST_CODEX_MODEL,
        },
        providerConfigs: {
          claude: {
            ...DEFAULT_CLAUDE_PROVIDER_SETTINGS,
            lastModel: 'fable',
            modelEnvironmentType: 'fable',
            environmentVariables: [
              'ANTHROPIC_DEFAULT_HAIKU_MODEL=haiku-v2',
              'ANTHROPIC_DEFAULT_FABLE_MODEL=fable-v2',
            ].join('\n'),
            environmentHash: [
              'ANTHROPIC_DEFAULT_FABLE_MODEL=fable-v1',
              'ANTHROPIC_DEFAULT_HAIKU_MODEL=haiku-v1',
            ].join('|'),
          },
          codex: {
            enabled: true,
            discoveredModels: TEST_CODEX_CATALOG,
          },
        },
      };

      ProviderSettingsCoordinator.reconcileProviders(settings, [], ['claude']);

      expect(settings.savedProviderModel).toMatchObject({
        claude: 'claude-code/fable-v2',
      });
      expect((settings.providerConfigs as Record<string, Record<string, unknown>>).claude)
        .toMatchObject({
          lastModel: 'fable',
          modelEnvironmentType: 'fable',
        });
    });

    it('migrates legacy inactive Fable state before provider projection replaces it', () => {
      const settings: Record<string, unknown> = {
        settingsProvider: 'codex',
        model: TEST_CODEX_MODEL,
        effortLevel: 'high',
        serviceTier: 'default',
        thinkingBudget: 'off',
        savedProviderModel: {
          claude: 'claude-code/fable-old',
          codex: TEST_CODEX_MODEL,
        },
        providerConfigs: {
          claude: {
            ...DEFAULT_CLAUDE_PROVIDER_SETTINGS,
            lastModel: 'fable',
            modelEnvironmentType: '',
            environmentVariables: [
              'ANTHROPIC_DEFAULT_HAIKU_MODEL=haiku-new',
              'ANTHROPIC_DEFAULT_FABLE_MODEL=fable-new',
            ].join('\n'),
            environmentHash: 'ANTHROPIC_DEFAULT_FABLE_MODEL=fable-old',
          },
          codex: {
            enabled: true,
            discoveredModels: TEST_CODEX_CATALOG,
          },
        },
      };

      ProviderSettingsCoordinator.reconcileProviders(settings, [], ['claude']);

      expect(settings.savedProviderModel).toMatchObject({
        claude: 'claude-code/fable-new',
      });
      expect((settings.providerConfigs as Record<string, Record<string, unknown>>).claude)
        .toMatchObject({
          lastModel: 'fable',
          modelEnvironmentType: 'fable',
        });
    });

    it('restores a title model after its environment source returns', () => {
      const settings: Record<string, unknown> = {
        settingsProvider: 'claude',
        model: 'claude-code/custom-haiku',
        titleGenerationModel: 'claude-code/fable-old',
        providerConfigs: {
          claude: {
            ...DEFAULT_CLAUDE_PROVIDER_SETTINGS,
            lastModel: 'haiku',
            modelEnvironmentType: 'haiku',
            titleModelEnvironmentType: 'fable',
            environmentVariables: 'ANTHROPIC_DEFAULT_HAIKU_MODEL=custom-haiku',
            environmentHash: [
              'ANTHROPIC_DEFAULT_FABLE_MODEL=fable-old',
              'ANTHROPIC_DEFAULT_HAIKU_MODEL=custom-haiku',
            ].join('|'),
          },
        },
      };

      ProviderSettingsCoordinator.reconcileProviders(settings, [], ['claude']);

      expect(settings.titleGenerationModel).toBe('');
      expect((settings.providerConfigs as Record<string, Record<string, unknown>>).claude)
        .toMatchObject({ titleModelEnvironmentType: 'fable' });

      (settings.providerConfigs as Record<string, Record<string, unknown>>).claude.environmentVariables = [
        'ANTHROPIC_DEFAULT_HAIKU_MODEL=custom-haiku',
        'ANTHROPIC_DEFAULT_FABLE_MODEL=fable-new',
      ].join('\n');

      ProviderSettingsCoordinator.reconcileProviders(settings, [], ['claude']);

      expect(settings.titleGenerationModel).toBe('claude-code/fable-new');
      expect((settings.providerConfigs as Record<string, Record<string, unknown>>).claude)
        .toMatchObject({ titleModelEnvironmentType: 'fable' });
    });
  });

  describe('projectActiveProviderState', () => {
    it('projects saved model and effort for the settings provider', () => {
      const settings: Record<string, unknown> = {
        settingsProvider: 'codex',
        providerConfigs: {
          codex: { enabled: true, discoveredModels: TEST_CODEX_CATALOG },
        },
        permissionMode: 'yolo',
        model: 'haiku',
        effortLevel: 'high',
        serviceTier: 'default',
        thinkingBudget: 'off',
        savedProviderModel: { codex: TEST_CODEX_MODEL, claude: 'haiku' },
        savedProviderEffort: { codex: 'medium', claude: 'high' },
        savedProviderServiceTier: { codex: 'fast', claude: 'default' },
        savedProviderThinkingBudget: { codex: '1024', claude: 'off' },
        savedProviderPermissionMode: { codex: 'normal', claude: 'yolo' },
      };

      ProviderSettingsCoordinator.projectActiveProviderState(settings);

      expect(settings.model).toBe(TEST_CODEX_MODEL);
      expect(settings.effortLevel).toBe('medium');
      expect(settings.serviceTier).toBe('fast');
      expect(settings.thinkingBudget).toBe('off');
      expect(settings.permissionMode).toBe('normal');
    });

    it('migrates a saved legacy Codex model before projecting provider state', () => {
      const settings: Record<string, unknown> = {
        settingsProvider: 'claude',
        model: 'haiku',
        effortLevel: 'high',
        serviceTier: 'default',
        thinkingBudget: 'off',
        providerConfigs: {
          codex: { enabled: true, discoveredModels: TEST_CODEX_CATALOG },
        },
        savedProviderModel: { claude: 'haiku', codex: 'gpt-5.4' },
        savedProviderEffort: { claude: 'high', codex: 'medium' },
        savedProviderServiceTier: { claude: 'default', codex: 'fast' },
        savedProviderThinkingBudget: { claude: 'off', codex: 'off' },
      };

      const snapshot = ProviderSettingsCoordinator.getProviderSettingsSnapshot(settings, 'codex');

      expect(snapshot.model).toBe(TEST_CODEX_MODEL);
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
      expect(settings.thinkingBudget).toBe('500');
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
          codex: { enabled: true, discoveredModels: TEST_CODEX_CATALOG },
        },
        permissionMode: 'normal',
        model: TEST_CODEX_MODEL,
        effortLevel: 'low',
        serviceTier: 'fast',
        thinkingBudget: 'off',
        savedProviderModel: { claude: 'haiku' },
        savedProviderEffort: { claude: 'high' },
        savedProviderServiceTier: { claude: 'default' },
        savedProviderThinkingBudget: { claude: 'off' },
        savedProviderPermissionMode: { claude: 'yolo' },
      };

      ProviderSettingsCoordinator.persistProjectedProviderState(settings);

      expect(settings.savedProviderModel).toEqual({
        claude: 'haiku',
        codex: TEST_CODEX_MODEL,
      });
      expect(settings.savedProviderEffort).toEqual({
        claude: 'high',
        codex: 'low',
      });
      expect(settings.savedProviderServiceTier).toEqual({
        claude: 'default',
        codex: 'fast',
      });
      expect(settings.savedProviderPermissionMode).toEqual({
        claude: 'yolo',
        codex: 'normal',
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
            discoveredModels: TEST_CODEX_CATALOG,
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

      expect(settings.model).toBe(TEST_CODEX_MODEL);
      expect(settings.effortLevel).toBe('high');
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

    it('derives OpenCode permission mode from the managed selected mode when no provider snapshot exists yet', () => {
      const settings: Record<string, unknown> = {
        settingsProvider: 'claude',
        permissionMode: 'yolo',
        providerConfigs: {
          opencode: {
            enabled: true,
            selectedMode: 'claudian-safe',
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
        savedProviderPermissionMode: {},
      };

      ProviderSettingsCoordinator.projectProviderState(settings, 'opencode');

      expect(settings.permissionMode).toBe('normal');
    });

    it('prefers the active OpenCode selected mode over a stale top-level permission projection', () => {
      const settings: Record<string, unknown> = {
        settingsProvider: 'opencode',
        permissionMode: 'normal',
        providerConfigs: {
          opencode: {
            enabled: true,
            selectedMode: 'build',
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
        savedProviderPermissionMode: {},
      };

      ProviderSettingsCoordinator.projectProviderState(settings, 'opencode');

      expect(settings.permissionMode).toBe('yolo');
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
            discoveredModels: TEST_CODEX_CATALOG,
            environmentVariables: `OPENAI_MODEL=${TEST_CODEX_MODEL}`,
          },
        },
        model: 'haiku',
        effortLevel: 'high',
        serviceTier: 'default',
        thinkingBudget: 'off',
        savedProviderModel: { claude: 'haiku', codex: TEST_CODEX_MODEL },
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
        codex: TEST_CODEX_MODEL,
      });
      expect(settings.savedProviderServiceTier).toEqual({
        claude: 'default',
        codex: 'fast',
      });
    });
  });
});
