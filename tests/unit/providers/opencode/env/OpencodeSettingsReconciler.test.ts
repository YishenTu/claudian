import '@/providers';

import { ProviderSettingsCoordinator } from '@/core/providers/ProviderSettingsCoordinator';
import { isVersionedRuntimeInputFingerprint } from '@/core/providers/settings/RuntimeInputFingerprint';
import { getOpencodeDiscoveryState, updateOpencodeDiscoveryState } from '@/providers/opencode/discoveryState';
import { opencodeSettingsReconciler } from '@/providers/opencode/env/OpencodeSettingsReconciler';

describe('coordinated OpenCode environment changes', () => {
  it('retains provider-owned discovery state when environment changes', () => {
    const settings: Record<string, unknown> = {};
    updateOpencodeDiscoveryState(settings, {
      discoveredModels: [{ label: 'OpenAI/GPT-5', rawId: 'openai/gpt-5' }],
    });

    expect(ProviderSettingsCoordinator.handleEnvironmentChange(settings, ['opencode'])).toBe(false);
    expect(getOpencodeDiscoveryState(settings)).toEqual({
      discoveredModels: [{ label: 'OpenAI/GPT-5', rawId: 'openai/gpt-5' }],
      thinkingOptionsByModel: {},
    });
  });
});

describe('opencodeSettingsReconciler.reconcileModelWithEnvironment', () => {
  it('keeps bindings on a recorded database and retires the rest when the runtime database/config env changes', () => {
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
        providerState: { databasePath: '/old/opencode.db', nativeConversationContextEstablished: true },
        sessionId: 'session-1',
      },
      {
        id: 'conv-unrecorded',
        messages: [],
        providerId: 'opencode',
        providerState: { nativeConversationContextEstablished: true },
        sessionId: 'session-2',
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
    // Native existence on the recorded database is decided later by `opencode serve`.
    expect(conversations[0]).toMatchObject({
      sessionId: 'session-1',
      providerState: { databasePath: '/old/opencode.db', nativeConversationContextEstablished: true },
    });
    // Without a recorded database the binding would follow the new default, so it is retired.
    expect(result.invalidatedConversations).toEqual([conversations[1]]);
    expect(conversations[1].sessionId).toBeNull();
    expect(conversations[1].providerState).toEqual({
      nativeConversationContextEstablished: false,
      previousSessions: [{ sessionId: 'session-2' }],
    });
    const fingerprint = (settings.providerConfigs as any).opencode.environmentHash;
    expect(isVersionedRuntimeInputFingerprint(fingerprint)).toBe(true);
    expect(fingerprint).not.toContain('/new/opencode.db');
  });
});
