import type { Conversation } from '@/core/types';
import { codexSettingsReconciler } from '@/providers/codex/env/CodexSettingsReconciler';
import { DEFAULT_CODEX_PRIMARY_MODEL } from '@/providers/codex/types/models';

describe('codexSettingsReconciler', () => {
  it('invalidates both sessionId and providerState when the Codex env hash changes', () => {
    const conversation = {
      providerId: 'codex',
      sessionId: 'thread-123',
      providerState: {
        threadId: 'thread-123',
        sessionFilePath: '/tmp/thread-123.jsonl',
      },
      messages: [],
    } as unknown as Conversation;

    const settings: Record<string, unknown> = {
      model: DEFAULT_CODEX_PRIMARY_MODEL,
      providerConfigs: {
        codex: {
          environmentVariables: `OPENAI_MODEL=${DEFAULT_CODEX_PRIMARY_MODEL}`,
          environmentHash: '',
        },
      },
    };

    const result = codexSettingsReconciler.reconcileModelWithEnvironment(settings, [conversation]);

    expect(result.changed).toBe(true);
    expect(conversation.sessionId).toBeNull();
    expect(conversation.providerState).toBeUndefined();
    expect(settings.model).toBe(DEFAULT_CODEX_PRIMARY_MODEL);
  });

  it('preserves an active settings-defined custom model across non-model env changes', () => {
    const conversation = {
      providerId: 'codex',
      sessionId: 'thread-123',
      providerState: {
        threadId: 'thread-123',
        sessionFilePath: '/tmp/thread-123.jsonl',
      },
      messages: [],
    } as unknown as Conversation;

    const settings: Record<string, unknown> = {
      model: 'my-custom-model',
      providerConfigs: {
        codex: {
          customModels: 'my-custom-model',
          environmentVariables: 'OPENAI_BASE_URL=https://api.example.com/v1',
          environmentHash: '',
        },
      },
    };

    const result = codexSettingsReconciler.reconcileModelWithEnvironment(settings, [conversation]);

    expect(result.changed).toBe(true);
    expect(result.invalidatedConversations).toEqual([conversation]);
    expect(conversation.sessionId).toBeNull();
    expect(conversation.providerState).toBeUndefined();
    expect(settings.model).toBe('my-custom-model');
    expect((settings.providerConfigs as any).codex.environmentHash).toBe(
      'OPENAI_BASE_URL=https://api.example.com/v1',
    );
  });

  it('tracks followed CC-Switch snapshots and selects the active model', () => {
    const conversation = {
      providerId: 'codex',
      sessionId: 'thread-123',
      providerState: {
        threadId: 'thread-123',
        sessionFilePath: '/tmp/thread-123.jsonl',
      },
      messages: [],
    } as unknown as Conversation;

    const settings: Record<string, unknown> = {
      model: DEFAULT_CODEX_PRIMARY_MODEL,
      providerConfigs: {
        codex: {
          followCCSwitch: true,
          ccSwitchSnapshot: {
            providerId: 'codex',
            model: 'gpt-5.5',
            modelProvider: 'openai-compatible',
            baseUrl: 'https://api.example.com/v1',
            configHash: 'switch-hash',
          },
          environmentHash: '',
        },
      },
    };

    const result = codexSettingsReconciler.reconcileModelWithEnvironment(settings, [conversation]);

    expect(result.changed).toBe(true);
    expect(result.invalidatedConversations).toEqual([conversation]);
    expect(settings.model).toBe('gpt-5.5');
    expect((settings.providerConfigs as any).codex.environmentHash).toBe('CC_SWITCH=switch-hash');
  });

  it('restores a built-in model when a settings-defined custom model is removed', () => {
    const settings: Record<string, unknown> = {
      model: 'my-custom-model',
      providerConfigs: {
        codex: {
          customModels: '',
          environmentVariables: 'OPENAI_BASE_URL=https://api.example.com/v1',
          environmentHash: '',
        },
      },
    };

    const result = codexSettingsReconciler.reconcileModelWithEnvironment(settings, []);

    expect(result.changed).toBe(true);
    expect(settings.model).toBe('gpt-5.4-mini');
    expect((settings.providerConfigs as any).codex.environmentHash).toBe(
      'OPENAI_BASE_URL=https://api.example.com/v1',
    );
  });
});
