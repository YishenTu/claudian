import { TEST_CODEX_CATALOG, TEST_CODEX_MODEL } from '@test/helpers/codexModels';

import type { Conversation } from '@/core/types';
import {
  codexSettingsReconciler,
  computeCodexEnvHash,
} from '@/providers/codex/env/CodexSettingsReconciler';

describe('codexSettingsReconciler', () => {
  it('fingerprints environment values without persisting secrets or raw URLs', () => {
    const hash = computeCodexEnvHash(
      'OPENAI_API_KEY=super-secret\nOPENAI_BASE_URL=https://api.example.com/v1\nOPENAI_MODEL=gpt-5.6-sol',
    );

    expect(hash).not.toContain('super-secret');
    expect(hash).not.toContain('https://api.example.com/v1');
    expect(hash).toMatch(/^OPENAI_API_KEY=[0-9a-f]{64}\|OPENAI_BASE_URL=[0-9a-f]{64}\|OPENAI_MODEL=[0-9a-f]{64}$/);
  });

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
      model: TEST_CODEX_MODEL,
      providerConfigs: {
        codex: {
          discoveredModels: TEST_CODEX_CATALOG,
          environmentVariables: `OPENAI_MODEL=${TEST_CODEX_MODEL}`,
          environmentHash: '',
        },
      },
    };

    const result = codexSettingsReconciler.reconcileModelWithEnvironment(settings, [conversation]);

    expect(result.changed).toBe(true);
    expect(conversation.sessionId).toBeNull();
    expect(conversation.providerState).toBeUndefined();
    expect(settings.model).toBe(TEST_CODEX_MODEL);
  });

  it('persists a provider-qualified selection for custom OPENAI_MODEL values', () => {
    const settings: Record<string, unknown> = {
      model: TEST_CODEX_MODEL,
      providerConfigs: {
        codex: {
          environmentVariables: 'OPENAI_MODEL=deepseek-v4-pro',
          environmentHash: '',
        },
      },
    };

    const result = codexSettingsReconciler.reconcileModelWithEnvironment(settings, []);

    expect(result.changed).toBe(true);
    expect(settings.model).toBe('openai-codex/deepseek-v4-pro');
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
    expect(settings.model).toBe('openai-codex/my-custom-model');
    expect((settings.providerConfigs as any).codex.environmentHash).toMatch(
      /^OPENAI_BASE_URL=[0-9a-f]{64}$/,
    );
  });

  it('restores a built-in model when a settings-defined custom model is removed', () => {
    const settings: Record<string, unknown> = {
      model: 'my-custom-model',
      providerConfigs: {
        codex: {
          customModels: '',
          discoveredModels: TEST_CODEX_CATALOG,
          environmentVariables: 'OPENAI_BASE_URL=https://api.example.com/v1',
          environmentHash: '',
        },
      },
    };

    const result = codexSettingsReconciler.reconcileModelWithEnvironment(settings, []);

    expect(result.changed).toBe(true);
    expect(settings.model).toBe(TEST_CODEX_MODEL);
    expect((settings.providerConfigs as any).codex.environmentHash).toMatch(
      /^OPENAI_BASE_URL=[0-9a-f]{64}$/,
    );
  });
});
