import { TEST_CODEX_CATALOG, TEST_CODEX_MODEL } from '@test/helpers/codexModels';

import { getInstallationKey } from '@/core/device/InstallationKey';
import { isVersionedRuntimeInputFingerprint } from '@/core/providers/settings/RuntimeInputFingerprint';
import type { Conversation } from '@/core/types';
import { codexSettingsReconciler } from '@/providers/codex/env/CodexSettingsReconciler';
import { computeCodexEnvHash } from '@/providers/codex/runtime/codexEnvironmentHash';

function establishedConversation(threadId: string): Conversation {
  return {
    providerId: 'codex',
    sessionId: threadId,
    providerState: {
      threadId,
      nativeConversationContextEstablished: true,
      sessionFilePath: `/tmp/${threadId}.jsonl`,
      transcriptRootPath: '/tmp',
      sessionToolVersion: 3,
    },
    messages: [],
  } as unknown as Conversation;
}

describe('codexSettingsReconciler', () => {
  it.each(['CODEX_HOME', 'HOME', 'USERPROFILE'])('invalidates native bindings when configured %s changes or is removed', key => {
    const settings: Record<string, unknown> = {
      providerConfigs: { codex: { enabled: true, environmentVariables: `${key}=/old-home` } },
    };
    codexSettingsReconciler.reconcileModelWithEnvironment(settings);
    for (const nextEnvironment of [`${key}=/new-home`, '']) {
      (settings.providerConfigs as any).codex.environmentVariables = nextEnvironment;
      expect(codexSettingsReconciler.reconcileModelWithEnvironment(settings))
        .toEqual({ changed: true, sessionPolicy: 'invalidate' });
    }
  });

  it('finalizes an empty legacy fingerprint before later runtime inputs change', () => {
    const settings: Record<string, unknown> = {
      model: TEST_CODEX_MODEL,
      providerConfigs: {
        codex: {
          enabled: true,
          discoveredModels: TEST_CODEX_CATALOG,
          environmentVariables: '',
          environmentHash: '',
        },
      },
    };

    expect(codexSettingsReconciler.normalizeModelVariantSettings(settings)).toBe(true);
    expect(isVersionedRuntimeInputFingerprint(
      (settings.providerConfigs as any).codex.environmentHash,
    )).toBe(true);
    expect(isVersionedRuntimeInputFingerprint(
      (settings.providerConfigs as any).codex.sessionEnvironmentHash,
    )).toBe(true);
    expect(codexSettingsReconciler.reconcileModelWithEnvironment(settings)).toEqual({ changed: false });

    (settings.providerConfigs as any).codex.environmentVariables = 'OPENAI_BASE_URL=https://new.example.com/v1';

    expect(codexSettingsReconciler.normalizeModelVariantSettings(settings)).toBe(false);
    expect(codexSettingsReconciler.reconcileModelWithEnvironment(settings))
      .toEqual({ changed: true, sessionPolicy: 'invalidate' });
  });

  it('retires an established binding into recovery-only history', () => {
    const conversation = establishedConversation('thread-123');
    const otherProvider = { providerId: 'claude', sessionId: 'claude-session', messages: [] } as unknown as Conversation;

    expect(codexSettingsReconciler.invalidateConversationSessions([conversation, otherProvider]))
      .toEqual([conversation]);
    expect(conversation.sessionId).toBeNull();
    expect(conversation.providerState).toEqual({
      nativeConversationContextEstablished: false,
      previousSegments: [{
        threadId: 'thread-123',
        sessionFilePath: '/tmp/thread-123.jsonl',
        transcriptRootPath: '/tmp',
      }],
    });
    expect(otherProvider.sessionId).toBe('claude-session');
  });

  it.each([
    ['CLI path', (codex: Record<string, unknown>) => { codex.cliPath = '/opt/codex/bin/codex'; }],
    ['host CLI path', (codex: Record<string, unknown>) => { codex.cliPathsByHost = { [getInstallationKey()]: '/opt/host/codex' }; }],
    ['PATH', (codex: Record<string, unknown>) => { codex.environmentVariables = 'PATH=/opt/codex/bin:/usr/bin'; }],
    ['OPENAI_MODEL', (codex: Record<string, unknown>) => { codex.environmentVariables = `OPENAI_MODEL=${TEST_CODEX_MODEL}`; }],
  ])('reloads without invalidating bindings when only the %s changes', (_input, change) => {
    const settings: Record<string, unknown> = {
      model: TEST_CODEX_MODEL,
      providerConfigs: {
        codex: {
          enabled: true,
          discoveredModels: TEST_CODEX_CATALOG,
          environmentVariables: '',
          environmentHash: '',
        },
      },
    };
    codexSettingsReconciler.normalizeModelVariantSettings(settings);
    const savedSessionHash = (settings.providerConfigs as any).codex.sessionEnvironmentHash;
    const savedRuntimeHash = (settings.providerConfigs as any).codex.environmentHash;

    change((settings.providerConfigs as any).codex);

    expect(codexSettingsReconciler.reconcileModelWithEnvironment(settings))
      .toEqual({ changed: true, sessionPolicy: 'reload' });
    expect((settings.providerConfigs as any).codex.environmentHash).not.toBe(savedRuntimeHash);
    expect((settings.providerConfigs as any).codex.sessionEnvironmentHash).toBe(savedSessionHash);
  });

  it.each([
    ['OPENAI_BASE_URL', (codex: Record<string, unknown>) => { codex.environmentVariables = 'OPENAI_BASE_URL=https://new.example.com/v1'; }],
    ['OPENAI_API_KEY', (codex: Record<string, unknown>) => { codex.environmentVariables = 'OPENAI_API_KEY=other-test-key'; }],
    ['installation method', (codex: Record<string, unknown>) => { codex.installationMethodsByHost = { [getInstallationKey()]: 'wsl' }; }],
    ['WSL distro', (codex: Record<string, unknown>) => { codex.wslDistroOverridesByHost = { [getInstallationKey()]: 'Ubuntu' }; }],
  ])('invalidates bindings when the %s changes', (_input, change) => {
    const settings: Record<string, unknown> = {
      model: TEST_CODEX_MODEL,
      providerConfigs: {
        codex: {
          enabled: true,
          discoveredModels: TEST_CODEX_CATALOG,
          environmentVariables: '',
          environmentHash: '',
        },
      },
    };
    codexSettingsReconciler.normalizeModelVariantSettings(settings);

    change((settings.providerConfigs as any).codex);

    expect(codexSettingsReconciler.reconcileModelWithEnvironment(settings))
      .toEqual({ changed: true, sessionPolicy: 'invalidate' });
  });

  it('backfills the session fingerprint without invalidating when runtime inputs are unchanged', () => {
    const settings: Record<string, unknown> = {
      model: TEST_CODEX_MODEL,
      providerConfigs: {
        codex: {
          enabled: true,
          cliPath: '/opt/codex/bin/codex',
          discoveredModels: TEST_CODEX_CATALOG,
          environmentVariables: 'CODEX_HOME=/data/codex',
          environmentHash: '',
        },
      },
    };
    codexSettingsReconciler.reconcileModelWithEnvironment(settings);
    (settings.providerConfigs as any).codex.sessionEnvironmentHash = '';

    expect(codexSettingsReconciler.reconcileModelWithEnvironment(settings))
      .toEqual({ changed: true, sessionPolicy: 'reload' });
    expect(isVersionedRuntimeInputFingerprint(
      (settings.providerConfigs as any).codex.sessionEnvironmentHash,
    )).toBe(true);

    (settings.providerConfigs as any).codex.cliPath = '/usr/local/bin/codex';
    expect(codexSettingsReconciler.reconcileModelWithEnvironment(settings))
      .toEqual({ changed: true, sessionPolicy: 'reload' });
  });

  it('migrates a legacy fingerprint with an existing CLI path without reporting a change', () => {
    const settings: Record<string, unknown> = {
      model: TEST_CODEX_MODEL,
      providerConfigs: {
        codex: {
          enabled: true,
          cliPath: 'C:\\Users\\tester\\codex.exe',
          discoveredModels: TEST_CODEX_CATALOG,
          environmentVariables: '',
          environmentHash: '',
        },
      },
    };

    expect(codexSettingsReconciler.normalizeModelVariantSettings(settings)).toBe(true);
    expect(codexSettingsReconciler.reconcileModelWithEnvironment(settings)).toEqual({ changed: false });
    expect(isVersionedRuntimeInputFingerprint(
      (settings.providerConfigs as any).codex.environmentHash,
    )).toBe(true);
    expect(isVersionedRuntimeInputFingerprint(
      (settings.providerConfigs as any).codex.sessionEnvironmentHash,
    )).toBe(true);
  });

  it('migrates a matching legacy environment fingerprint without reporting a change', () => {
    const settings: Record<string, unknown> = {
      model: TEST_CODEX_MODEL,
      providerConfigs: {
        codex: {
          enabled: true,
          discoveredModels: TEST_CODEX_CATALOG,
          environmentVariables: 'OPENAI_BASE_URL=https://same.example.com/v1',
          environmentHash: 'OPENAI_BASE_URL=https://same.example.com/v1',
        },
      },
    };

    expect(codexSettingsReconciler.normalizeModelVariantSettings(settings)).toBe(true);
    expect(codexSettingsReconciler.reconcileModelWithEnvironment(settings)).toEqual({ changed: false });
    expect(isVersionedRuntimeInputFingerprint(
      (settings.providerConfigs as any).codex.environmentHash,
    )).toBe(true);
  });

  it('invalidates bindings when legacy settings contain a real environment change', () => {
    const settings: Record<string, unknown> = {
      model: TEST_CODEX_MODEL,
      providerConfigs: {
        codex: {
          enabled: true,
          discoveredModels: TEST_CODEX_CATALOG,
          environmentVariables: 'OPENAI_BASE_URL=https://new.example.com/v1',
          environmentHash: 'OPENAI_BASE_URL=https://old.example.com/v1',
        },
      },
    };

    expect(codexSettingsReconciler.normalizeModelVariantSettings(settings)).toBe(true);
    expect(codexSettingsReconciler.reconcileModelWithEnvironment(settings))
      .toEqual({ changed: true, sessionPolicy: 'invalidate' });
  });

  it.each([
    ['OPENAI_MODEL', { environmentVariables: `OPENAI_MODEL=${TEST_CODEX_MODEL}` }, 'reload'],
    ['CLI path', { cliPath: '/opt/codex/bin/codex' }, 'reload'],
    ['OPENAI_BASE_URL', { environmentVariables: 'OPENAI_BASE_URL=https://new.example.com/v1' }, 'invalidate'],
    ['CODEX_HOME', { environmentVariables: 'CODEX_HOME=/data/codex' }, 'invalidate'],
  ] as const)('scopes a first %s input on a never-fingerprinted config', (_input, inputs, sessionPolicy) => {
    const settings: Record<string, unknown> = {
      model: TEST_CODEX_MODEL,
      providerConfigs: {
        codex: {
          enabled: true,
          discoveredModels: TEST_CODEX_CATALOG,
          environmentVariables: '',
          environmentHash: '',
          ...inputs,
        },
      },
    };

    expect(codexSettingsReconciler.reconcileModelWithEnvironment(settings)).toEqual({ changed: true, sessionPolicy });
    // Model selection is re-resolved on every runtime change, including reloads.
    expect(settings.model).toBe(`openai-codex/${TEST_CODEX_MODEL}`);
  });

  it('preserves the selected model when OPENAI_MODEL changes', () => {
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

    const result = codexSettingsReconciler.reconcileModelWithEnvironment(settings);

    expect(result.changed).toBe(true);
    expect(settings.model).toBe(TEST_CODEX_MODEL);
  });

  it('preserves an active settings-defined custom model across non-model env changes', () => {
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

    const result = codexSettingsReconciler.reconcileModelWithEnvironment(settings);

    expect(result).toEqual({ changed: true, sessionPolicy: 'invalidate' });
    expect(settings.model).toBe('my-custom-model');
    const fingerprint = (settings.providerConfigs as any).codex.environmentHash;
    expect(isVersionedRuntimeInputFingerprint(fingerprint)).toBe(true);
    expect(fingerprint).not.toContain('https://api.example.com/v1');
  });

  it('preserves the selected custom model after its configuration is removed', () => {
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

    const result = codexSettingsReconciler.reconcileModelWithEnvironment(settings);

    expect(result.changed).toBe(true);
    expect(settings.model).toBe('my-custom-model');
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
