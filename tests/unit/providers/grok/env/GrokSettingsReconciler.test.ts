import type { Conversation } from '@/core/types';
import {
  computeGrokEnvironmentHash,
  grokSettingsReconciler,
} from '@/providers/grok/env/GrokSettingsReconciler';
import { getGrokProviderSettings } from '@/providers/grok/settings';

jest.mock('@/utils/env', () => ({
  ...jest.requireActual('@/utils/env'),
  getHostnameKey: () => 'current-host',
  getLegacyHostnameKey: () => 'legacy-host',
}));

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
    const first = computeGrokEnvironmentHash({
      providerConfigs: {
        grok: {
          cliPathsByHost: { 'current-host': '/bin/grok' },
          environmentVariables: 'XAI_API_KEY=super-secret\nGROK_HOME=/tmp/grok',
        },
      },
      sharedEnvironmentVariables: 'HTTPS_PROXY=https://proxy.example.com',
    });
    const reordered = computeGrokEnvironmentHash({
      providerConfigs: {
        grok: {
          cliPathsByHost: { 'current-host': '/bin/grok' },
          environmentVariables: 'GROK_HOME=/tmp/grok\nXAI_API_KEY=super-secret',
        },
      },
      sharedEnvironmentVariables: 'HTTPS_PROXY=https://proxy.example.com',
    });

    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(first).toBe(reordered);
    expect(first).not.toContain('super-secret');
    expect(first).not.toContain('/tmp/grok');
  });

  it('declares reload and preserves all conversation bindings', () => {
    const grokConversation = {
      messages: [],
      providerId: 'grok',
      providerState: { sessionDirectory: '/tmp/grok/session-1' },
      sessionId: 'session-1',
    } as unknown as Conversation;

    expect(grokSettingsReconciler.environmentSessionPolicy).toBe('reload');
    expect(grokSettingsReconciler.invalidateConversationSessions([grokConversation]))
      .toEqual([]);
    expect(grokConversation).toEqual(expect.objectContaining({
      providerState: { sessionDirectory: '/tmp/grok/session-1' },
      sessionId: 'session-1',
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

    expect(grokSettingsReconciler.reconcileModelWithEnvironment(settings, []))
      .toEqual({ changed: false, invalidatedConversations: [] });
    expect(getGrokProviderSettings(settings).environmentHash).toBe('');
  });

  it('clears only the current host catalog when construction inputs become stale', () => {
    const settings: Record<string, unknown> = {
      providerConfigs: {
        codex: { enabled: true, marker: 'untouched' },
        grok: {
          catalogsByHost: {
            'current-host': catalog('current-model'),
            'other-host': catalog('other-model'),
          },
          enabled: true,
          environmentHash: 'stale-hash',
          environmentVariables: 'XAI_API_KEY=new-secret',
        },
      },
    };
    const grokConversation = {
      messages: [],
      providerId: 'grok',
      providerState: { sessionDirectory: '/tmp/grok/session-1' },
      sessionId: 'session-1',
    } as unknown as Conversation;
    const otherConversation = {
      messages: [],
      providerId: 'claude',
      providerState: { providerSessionId: 'claude-session' },
      sessionId: 'claude-session',
    } as unknown as Conversation;

    const result = grokSettingsReconciler.reconcileModelWithEnvironment(
      settings,
      [grokConversation, otherConversation],
    );

    expect(result).toEqual({ changed: true, invalidatedConversations: [] });
    expect(getGrokProviderSettings(settings).catalogsByHost).toEqual({
      'other-host': catalog('other-model'),
    });
    expect(getGrokProviderSettings(settings).environmentHash)
      .toBe(computeGrokEnvironmentHash(settings));
    expect(grokConversation.sessionId).toBe('session-1');
    expect(otherConversation.sessionId).toBe('claude-session');
    expect((settings.providerConfigs as Record<string, unknown>).codex).toEqual({
      enabled: true,
      marker: 'untouched',
    });
  });

  it('retains the current catalog when the construction digest is current', () => {
    const settings: Record<string, unknown> = {
      providerConfigs: {
        grok: {
          catalogsByHost: { 'current-host': catalog('current-model') },
          enabled: true,
          environmentVariables: 'GROK_HOME=/tmp/grok',
        },
      },
    };
    (settings.providerConfigs as Record<string, any>).grok.environmentHash =
      computeGrokEnvironmentHash(settings);

    expect(grokSettingsReconciler.reconcileModelWithEnvironment(settings, []))
      .toEqual({ changed: false, invalidatedConversations: [] });
    expect(getGrokProviderSettings(settings).currentCatalog).toEqual(catalog('current-model'));
  });
});
