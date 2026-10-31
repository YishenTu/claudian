import '@/providers';

import { testDate } from '@test/helpers/testClock';

import { getInstallationKey } from '@/core/device/InstallationKey';
import { getProviderConfig } from '@/core/providers/providerConfig';
import { ProviderSettingsCoordinator } from '@/core/providers/ProviderSettingsCoordinator';
import { isVersionedRuntimeInputFingerprint } from '@/core/providers/settings/RuntimeInputFingerprint';
import type { Conversation } from '@/core/types';
import { getOpencodeDiscoveryState, updateOpencodeDiscoveryState } from '@/providers/opencode/discoveryState';
import { opencodeSettingsReconciler } from '@/providers/opencode/env/OpencodeSettingsReconciler';
import { opencodeProviderRegistration } from '@/providers/opencode/registration';

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
    ].map(conversation => ({ title: 'Test', createdAt: 1, lastActivityAt: 1, ...conversation }));

    const result = opencodeSettingsReconciler.reconcileModelWithEnvironment(settings);
    const invalidated = opencodeSettingsReconciler.invalidateConversationSessions(conversations);

    expect(result.changed).toBe(true);
    // Native existence on the recorded database is decided later by `opencode serve`.
    expect(conversations[0]).toMatchObject({
      sessionId: 'session-1',
      providerState: { databasePath: '/old/opencode.db', nativeConversationContextEstablished: true },
    });
    // Without a recorded database the binding would follow the new default, so it is retired.
    expect(invalidated).toEqual([conversations[1]]);
    expect(conversations[1].sessionId).toBeNull();
    expect(conversations[1].providerState).toEqual({
      nativeConversationContextEstablished: false,
      previousSessions: [{ sessionId: 'session-2' }],
    });
    const fingerprint = getProviderConfig(settings, 'opencode').environmentHash;
    expect(isVersionedRuntimeInputFingerprint(fingerprint)).toBe(true);
    expect(fingerprint).not.toContain('/new/opencode.db');
  });
});

it('reconciles vault-inferred distro changes and preserves recorded locators', () => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
  try {
    const key = getInstallationKey();
    const settings = { providerConfigs: { opencode: { enabled: true, installationMethodsByHost: { [key]: 'wsl' } } } };
    expect(opencodeSettingsReconciler.reconcileModelWithEnvironment(settings, { vaultPath: '\\\\wsl$\\Ubuntu\\vault' }).changed).toBe(true);
    expect(opencodeSettingsReconciler.reconcileModelWithEnvironment(settings, { vaultPath: '\\\\wsl$\\Ubuntu\\vault' }).changed).toBe(false);
    expect(opencodeSettingsReconciler.reconcileModelWithEnvironment(settings, { vaultPath: '\\\\wsl$\\Debian\\vault' }).changed).toBe(true);
    const databasePath = '\\\\wsl$\\Ubuntu\\home\\alice\\.local\\share\\opencode\\opencode.db';
    const conversation: Conversation = {
      id: 'conversation', providerId: 'opencode', title: 'WSL', messages: [], sessionId: 'native', providerState: { databasePath },
      createdAt: testDate().getTime(), lastActivityAt: testDate().getTime(),
    };
    expect(opencodeSettingsReconciler.invalidateConversationSessions([conversation])).toEqual([]);
    expect(opencodeProviderRegistration.historyService?.buildPersistedProviderState?.(conversation)).toMatchObject({ databasePath });
  } finally { Object.defineProperty(process, 'platform', platform); }
});
