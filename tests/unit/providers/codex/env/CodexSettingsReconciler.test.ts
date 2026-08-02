import { TEST_CODEX_CATALOG, TEST_CODEX_MODEL } from '@test/helpers/codexModels';

import { isVersionedRuntimeInputFingerprint } from '@/core/providers/settings/RuntimeInputFingerprint';
import type { Conversation } from '@/core/types';
import {
  codexSettingsReconciler,
  computeCodexEnvHash,
} from '@/providers/codex/env/CodexSettingsReconciler';

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
      model: TEST_CODEX_MODEL,
      providerConfigs: {
        codex: {
          enabled: true,
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
          enabled: true,
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
          enabled: true,
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
    const fingerprint = (settings.providerConfigs as any).codex.environmentHash;
    expect(isVersionedRuntimeInputFingerprint(fingerprint)).toBe(true);
    expect(fingerprint).not.toContain('https://api.example.com/v1');
  });

  it('restores a built-in model when a settings-defined custom model is removed', () => {
    const settings: Record<string, unknown> = {
      model: 'my-custom-model',
      providerConfigs: {
        codex: {
          enabled: true,
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
    expect(isVersionedRuntimeInputFingerprint(
      (settings.providerConfigs as any).codex.environmentHash,
    )).toBe(true);
  });

  it('persists an opaque API-key-sensitive fingerprint without exposing the key', () => {
    const secret = 'codex-test-secret-value';
    const fingerprint = computeCodexEnvHash(`OPENAI_API_KEY=${secret}`);

    expect(isVersionedRuntimeInputFingerprint(fingerprint)).toBe(true);
    expect(fingerprint).not.toContain(secret);
    expect(fingerprint).not.toContain(Buffer.from(secret, 'utf8').toString('base64'));
    expect(fingerprint).not.toContain(Buffer.from(secret, 'utf8').toString('hex'));
    expect(computeCodexEnvHash('OPENAI_API_KEY=other-test-secret')).not.toBe(fingerprint);
  });
});
