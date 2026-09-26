import '@/providers';

import { ProviderSettingsCoordinator } from '@/core/providers/ProviderSettingsCoordinator';
import { isVersionedRuntimeInputFingerprint } from '@/core/providers/settings/RuntimeInputFingerprint';
import { getOpencodeDiscoveryState, updateOpencodeDiscoveryState } from '@/providers/opencode/discoveryState';
import { opencodeSettingsReconciler } from '@/providers/opencode/env/OpencodeSettingsReconciler';

describe('coordinated OpenCode environment changes', () => {
  it('retains provider-owned discovery state when environment changes', () => {
    const settings: Record<string, unknown> = {};
    updateOpencodeDiscoveryState(settings, {
      availableModes: [{ id: 'build', name: 'Build' }],
      discoveredModels: [{ label: 'OpenAI/GPT-5', rawId: 'openai/gpt-5' }],
    });

    expect(ProviderSettingsCoordinator.handleEnvironmentChange(settings, ['opencode'])).toBe(false);
    expect(getOpencodeDiscoveryState(settings)).toEqual({
      availableModes: [{ id: 'build', name: 'Build' }],
      discoveredModels: [{ label: 'OpenAI/GPT-5', rawId: 'openai/gpt-5' }],
      thinkingOptionsByModel: {},
    });
  });
});

describe('opencodeSettingsReconciler.reconcileModelWithEnvironment', () => {
  it('invalidates persisted OpenCode session state when the runtime database/config env changes', () => {
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

    const result = opencodeSettingsReconciler.reconcileModelWithEnvironment(settings, conversations);

    expect(result.changed).toBe(true);
    expect(result.invalidatedConversations).toHaveLength(1);
    expect(conversations[0].sessionId).toBeNull();
    expect(conversations[0].providerState).toBeUndefined();
    const fingerprint = (settings.providerConfigs as any).opencode.environmentHash;
    expect(isVersionedRuntimeInputFingerprint(fingerprint)).toBe(true);
    expect(fingerprint).not.toContain('/new/opencode.db');
  });
});
