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

  it('restores a built-in model when OPENAI_MODEL is removed', () => {
    const settings: Record<string, unknown> = {
      model: 'my-custom-model',
      providerConfigs: {
        codex: {
          environmentVariables: '',
          environmentHash: 'OPENAI_MODEL=my-custom-model',
        },
      },
    };

    const result = codexSettingsReconciler.reconcileModelWithEnvironment(settings, []);

    expect(result.changed).toBe(true);
    expect(settings.model).toBe('gpt-5.4-mini');
    expect((settings.providerConfigs as any).codex.environmentHash).toBe('');
  });
});
