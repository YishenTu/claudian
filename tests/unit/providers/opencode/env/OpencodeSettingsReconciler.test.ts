import '@/providers';

import { getProviderConfig } from '@/core/providers/providerConfig';
import { ProviderSettingsCoordinator } from '@/core/providers/ProviderSettingsCoordinator';
import { isVersionedRuntimeInputFingerprint } from '@/core/providers/settings/RuntimeInputFingerprint';
import { getOpencodeDiscoveryState, updateOpencodeDiscoveryState } from '@/providers/opencode/discoveryState';
import { opencodeSettingsReconciler } from '@/providers/opencode/env/OpencodeSettingsReconciler';

describe('coordinated OpenCode environment changes', () => {
  it('retains provider-owned discovery state when environment changes', () => {
    const config: Record<string, unknown> = {};
    updateOpencodeDiscoveryState(config, {
      discoveredModels: [{ label: 'OpenAI/GPT-5', rawId: 'openai/gpt-5' }],
    });
    const settings: Record<string, unknown> = { providerConfigs: { opencode: config } };

    expect(ProviderSettingsCoordinator.handleEnvironmentChange(settings, ['opencode'])).toBe(false);
    expect(getOpencodeDiscoveryState(getProviderConfig(settings, 'opencode'))).toEqual({
      discoveredModels: [{ label: 'OpenAI/GPT-5', rawId: 'openai/gpt-5' }],
      thinkingOptionsByModel: {},
    });
  });
});

describe('opencodeSettingsReconciler.reconcileModelWithEnvironment', () => {
  it('retires the native binding to history-only state when the runtime database/config env changes', () => {
    const settings: Record<string, unknown> = {
      providerConfigs: {
        opencode: {
          enabled: true,
          environmentHash: 'OPENCODE_DB=/old/opencode.db',
          environmentVariables: 'OPENCODE_DB=/new/opencode.db\nOPENCODE_CONFIG=/tmp/opencode.json',
        },
      },
    };
    const conversations = [
      {
        id: 'conv-opencode',
        messages: [],
        providerId: 'opencode',
        providerState: { databasePath: '/old/opencode.db' },
        sessionId: 'session-1',
      },
      {
        id: 'conv-other',
        messages: [],
        providerId: 'claude',
        providerState: { providerSessionId: 'claude-session' },
        sessionId: 'claude-session',
      },
    ] as any;

    expect(opencodeSettingsReconciler.reconcileModelWithEnvironment(settings)).toEqual({ changed: true });
    expect(opencodeSettingsReconciler.invalidateConversationSessions(conversations)).toEqual([conversations[0]]);
    expect(conversations[0].sessionId).toBeNull();
    expect(conversations[0].providerState).toEqual({
      nativeConversationContextEstablished: false,
      previousSessions: [{ sessionId: 'session-1', databasePath: '/old/opencode.db' }],
    });
    const fingerprint = (settings.providerConfigs as any).opencode.environmentHash;
    expect(isVersionedRuntimeInputFingerprint(fingerprint)).toBe(true);
    expect(fingerprint).not.toContain('/new/opencode.db');
  });
});
