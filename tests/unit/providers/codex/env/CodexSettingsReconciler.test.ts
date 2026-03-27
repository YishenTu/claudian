import type { Conversation } from '@/core/types';
import { codexSettingsReconciler } from '@/providers/codex/env/CodexSettingsReconciler';

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
      model: 'codex-mini',
      lastCodexEnvHash: '',
    };

    const result = codexSettingsReconciler.reconcileModelWithEnvironment(
      settings,
      [conversation],
      'OPENAI_MODEL=gpt-4.1',
    );

    expect(result.changed).toBe(true);
    expect(conversation.sessionId).toBeNull();
    expect(conversation.providerState).toBeUndefined();
    expect(settings.model).toBe('gpt-4.1');
  });

  it('restores a built-in model when OPENAI_MODEL is removed', () => {
    const settings: Record<string, unknown> = {
      model: 'my-custom-model',
      lastCodexEnvHash: 'OPENAI_MODEL=my-custom-model',
    };

    const result = codexSettingsReconciler.reconcileModelWithEnvironment(
      settings,
      [],
      '',
    );

    expect(result.changed).toBe(true);
    expect(settings.model).toBe('codex-mini');
    expect(settings.lastCodexEnvHash).toBe('');
  });
});
