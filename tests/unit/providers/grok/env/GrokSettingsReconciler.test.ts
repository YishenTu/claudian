import { conversationRecord } from '@test/helpers/features/chat/ConversationFixture';
import { grokEnvironmentHash } from '@test/helpers/providers/grokSettings';

import { getInstallationKey } from '@/core/device/InstallationKey';
import { getProviderConfig, setProviderConfig } from '@/core/providers/providerConfig';
import { isVersionedRuntimeInputFingerprint } from '@/core/providers/settings/RuntimeInputFingerprint';
import { grokSettingsReconciler } from '@/providers/grok/env/GrokSettingsReconciler';
import { getGrokProviderSettings } from '@/providers/grok/settings';

describe('GrokSettingsReconciler', () => {
  const catalog = (rawId: string) => ({
    defaultModelId: rawId,
    fingerprint: `${rawId}-fingerprint`,
    models: [{
      displayName: rawId,
      rawId,
      reasoningEfforts: [],
      supportsReasoning: false,
    }],
    refreshedAt: 1,
  });

  it('computes a stable SHA-256 digest without exposing raw secret values', () => {
    const first = grokEnvironmentHash({
      providerConfigs: {
        grok: {
          cliPathsByHost: { [getInstallationKey()]: '/bin/grok' },
          environmentVariables: 'XAI_API_KEY=super-secret\nGROK_HOME=/tmp/grok',
        },
      },
      sharedEnvironmentVariables: 'HTTPS_PROXY=https://proxy.example.com',
    });
    const reordered = grokEnvironmentHash({
      providerConfigs: {
        grok: {
          cliPathsByHost: { [getInstallationKey()]: '/bin/grok' },
          environmentVariables: 'GROK_HOME=/tmp/grok\nXAI_API_KEY=super-secret',
        },
      },
      sharedEnvironmentVariables: 'HTTPS_PROXY=https://proxy.example.com',
    });

    expect(isVersionedRuntimeInputFingerprint(first)).toBe(true);
    expect(first).toBe(reordered);
    expect(first).not.toContain('super-secret');
    expect(first).not.toContain('/tmp/grok');
  });

  it('fingerprints the legacy CLI fallback independently from the hostname candidate', () => {
    const createSettings = (legacyCliPath: string): Record<string, unknown> => ({
      providerConfigs: {
        grok: {
          cliPath: legacyCliPath,
          cliPathsByHost: { [getInstallationKey()]: '/missing/hostname-grok' },
          environmentVariables: '',
        },
      },
    });

    expect(grokEnvironmentHash(createSettings('/bin/grok-a'))).not.toBe(
      grokEnvironmentHash(createSettings('/bin/grok-b')),
    );
  });

  it('retires resume identity while retaining a history-only locator', () => {
    const grokConversation = conversationRecord('conversation', {
      messages: [],
      providerId: 'grok',
      providerState: { sessionDirectory: '/tmp/grok/session-1' },
      sessionId: 'session-1',
    });

    expect(grokSettingsReconciler.invalidateConversationSessions([grokConversation]))
      .toEqual([grokConversation]);
    expect(grokConversation).toEqual(expect.objectContaining({
      providerState: { sessionDirectory: '/tmp/grok/session-1', historySessionId: 'session-1', nativeConversationContextEstablished: false },
      sessionId: null,
    }));
  });

  it('leaves pristine disabled defaults untouched during startup reconciliation', () => {
    const settings: Record<string, unknown> = {
      providerConfigs: {
        grok: {
          catalogsByHost: {},
          enabled: false,
          environmentHash: '',
          environmentVariables: '',
        },
      },
    };

    expect(grokSettingsReconciler.reconcileModelWithEnvironment(settings)).toEqual({ changed: false });
    expect(getGrokProviderSettings(settings).environmentHash).toBe('');
  });

  it('retains the current host catalog when construction inputs become stale', () => {
    const settings: Record<string, unknown> = {
      providerConfigs: {
        codex: { enabled: true, marker: 'untouched' },
        grok: {
          catalogsByHost: {
            [getInstallationKey()]: catalog('current-model'),
            'other-host': catalog('other-model'),
          },
          enabled: true,
          environmentHash: 'stale-hash',
          environmentVariables: 'XAI_API_KEY=new-secret',
        },
      },
    };
    const grokConversation = conversationRecord('conversation', {
      messages: [],
      providerId: 'grok',
      providerState: { sessionDirectory: '/tmp/grok/session-1' },
      sessionId: 'session-1',
    });

    const result = grokSettingsReconciler.reconcileModelWithEnvironment(settings);

    expect(result).toEqual({ changed: true, sessionPolicy: 'reload' });
    expect(getGrokProviderSettings(settings).catalogsByHost).toEqual({
      [getInstallationKey()]: catalog('current-model'),
      'other-host': catalog('other-model'),
    });
    expect(getGrokProviderSettings(settings).environmentHash)
      .toBe(grokEnvironmentHash(settings));
    expect(grokConversation.sessionId).toBe('session-1');
    expect((settings.providerConfigs as Record<string, unknown>).codex).toEqual({
      enabled: true,
      marker: 'untouched',
    });
  });

  it('retains the current catalog when the construction digest is current', () => {
    const settings: Record<string, unknown> = {
      providerConfigs: {
        grok: {
          catalogsByHost: { [getInstallationKey()]: catalog('current-model') },
          enabled: true,
          environmentVariables: 'GROK_HOME=/tmp/grok',
        },
      },
    };
    setProviderConfig(settings, 'grok', { ...getProviderConfig(settings, 'grok'), environmentHash: grokEnvironmentHash(settings) });

    expect(grokSettingsReconciler.reconcileModelWithEnvironment(settings)).toEqual({ changed: true, sessionPolicy: 'reload' });
    expect(grokSettingsReconciler.reconcileModelWithEnvironment(settings)).toEqual({ changed: false });
    expect(getGrokProviderSettings(settings).currentCatalog).toEqual(catalog('current-model'));
  });

  it('normalizes qualified Grok selections in every shared model slot', () => {
    const settings: Record<string, unknown> = {
      model: '  grok/grok-4.5  ',
      titleGenerationModel: ' grok/grok-3 ',
      savedProviderModel: {
        claude: 'claude-sonnet-4-5',
        grok: ' grok/grok-code-fast-1 ',
      },
    };

    expect(grokSettingsReconciler.normalizeModelVariantSettings!(settings)).toBe(true);
    expect(settings).toEqual({
      model: 'grok/grok-4.5',
      titleGenerationModel: 'grok/grok-3',
      savedProviderModel: {
        claude: 'claude-sonnet-4-5',
        grok: 'grok/grok-code-fast-1',
      },
    });
  });

  it('leaves normalized, unqualified, and unrelated provider selections unchanged', () => {
    const settings: Record<string, unknown> = {
      model: 'grok/grok-4.5',
      titleGenerationModel: 'claude-sonnet-4-5',
      savedProviderModel: {
        codex: 'gpt-5.4',
        grok: 'grok-3',
      },
    };

    expect(grokSettingsReconciler.normalizeModelVariantSettings!(settings)).toBe(false);
    expect(settings).toEqual({
      model: 'grok/grok-4.5',
      titleGenerationModel: 'claude-sonnet-4-5',
      savedProviderModel: {
        codex: 'gpt-5.4',
        grok: 'grok-3',
      },
    });
  });
});

describe('Grok session store transitions', () => {
  afterEach(() => vi.unstubAllGlobals());
  it('reloads CLI changes but invalidates target, distro and store changes', () => {
    vi.stubGlobal('process', { ...process, platform: 'win32' });
    const settings = { providerConfigs: { grok: { enabled: true } as Record<string, unknown> } };
    grokSettingsReconciler.reconcileModelWithEnvironment(settings);
    settings.providerConfigs.grok.cliPath = 'C:\\new-grok.exe';
    expect(grokSettingsReconciler.reconcileModelWithEnvironment(settings)).toMatchObject({ sessionPolicy: 'reload' });
    settings.providerConfigs.grok.installationMethodsByHost = { [getInstallationKey()]: 'wsl' };
    settings.providerConfigs.grok.wslDistroOverridesByHost = { [getInstallationKey()]: 'Ubuntu' };
    expect(grokSettingsReconciler.reconcileModelWithEnvironment(settings)).toMatchObject({ sessionPolicy: 'invalidate' });
    settings.providerConfigs.grok.wslDistroOverridesByHost = { [getInstallationKey()]: 'Debian' };
    expect(grokSettingsReconciler.reconcileModelWithEnvironment(settings)).toMatchObject({ sessionPolicy: 'invalidate' });
    settings.providerConfigs.grok.environmentVariables = 'GROK_HOME=/other-store';
    expect(grokSettingsReconciler.reconcileModelWithEnvironment(settings)).toMatchObject({ sessionPolicy: 'invalidate' });
  });
});

describe('Grok effective store selection', () => {
  it('reloads a shadowed HOME change when GROK_HOME still selects the same store', () => {
    const settings = { providerConfigs: { grok: { enabled: true, environmentVariables: 'GROK_HOME=/same-store\nHOME=/home/a' } } };
    grokSettingsReconciler.reconcileModelWithEnvironment(settings);
    settings.providerConfigs.grok.environmentVariables = 'GROK_HOME=/same-store\nHOME=/home/b';
    expect(grokSettingsReconciler.reconcileModelWithEnvironment(settings)).toMatchObject({ changed: true, sessionPolicy: 'reload' });
  });
});
