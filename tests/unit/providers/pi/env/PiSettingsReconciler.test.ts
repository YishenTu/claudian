import '@/providers';

import { getInstallationKey } from '@/core/device/InstallationKey';
import { ProviderSettingsCoordinator } from '@/core/providers/ProviderSettingsCoordinator';
import { isVersionedRuntimeInputFingerprint } from '@/core/providers/settings/RuntimeInputFingerprint';
import type { Conversation } from '@/core/types';
import { piSettingsReconciler } from '@/providers/pi/env/PiSettingsReconciler';
import { getPiProviderSettings } from '@/providers/pi/settings';

interface PiFingerprintInputs {
  cliPath?: string;
  environment?: string;
  hostCliPath?: string;
}

function toPiConfig({ cliPath = '', environment = '', hostCliPath }: PiFingerprintInputs) {
  return {
    enabled: true,
    cliPath,
    cliPathsByHost: hostCliPath ? { [getInstallationKey()]: hostCliPath } : {},
    environmentVariables: environment,
  };
}

function createBoundPiConversation(): Conversation {
  return {
    id: 'pi-conversation',
    messages: [],
    providerId: 'pi',
    providerState: {
      leafEntryId: 'assistant-1',
      sessionFile: '/sessions/current.jsonl',
      sessionId: 'current-session',
    },
    sessionId: 'current-session',
  } as unknown as Conversation;
}

describe('piSettingsReconciler', () => {
  it.each(['PI_CODING_AGENT_DIR', 'PI_CODING_AGENT_SESSION_DIR', 'PI_PACKAGE_DIR'])(
    'invalidates native bindings when location-affecting %s changes or is removed',
    key => {
      const settings: Record<string, unknown> = {
        providerConfigs: { pi: toPiConfig({ environment: `${key}=/old\nPI_OFFLINE=1` }) },
      };
      piSettingsReconciler.reconcileModelWithEnvironment(settings, []);
      for (const environment of [`${key}=/new\nPI_OFFLINE=1`, 'PI_OFFLINE=1']) {
        (settings.providerConfigs as any).pi.environmentVariables = environment;
        const conversation = createBoundPiConversation();
        const result = piSettingsReconciler.reconcileModelWithEnvironment(settings, [conversation]);
        expect(result).toEqual({
          changed: true,
          invalidatedConversations: [conversation],
          sessionPolicy: 'invalidate',
        });
        expect(conversation.sessionId).toBeNull();
        expect(conversation.providerState).toEqual({
          bindingRetired: true,
          previousSessions: [{
            leafEntryId: 'assistant-1',
            sessionFile: '/sessions/current.jsonl',
            sessionId: 'current-session',
          }],
        });
      }
    },
  );

  it.each<[string, PiFingerprintInputs, PiFingerprintInputs]>([
    ['the CLI path', { cliPath: '/old/pi' }, { cliPath: '/new/pi' }],
    ['the host CLI path', { hostCliPath: '/old/pi' }, { hostCliPath: '/new/pi' }],
    ['PATH', { environment: 'PATH=/old/bin' }, { environment: 'PATH=/new/bin' }],
    ['PI_OFFLINE', { environment: 'PI_OFFLINE=1' }, { environment: '' }],
    ['PI_SKIP_VERSION_CHECK', { environment: '' }, { environment: 'PI_SKIP_VERSION_CHECK=1' }],
    ['PI_TELEMETRY', { environment: 'PI_TELEMETRY=1' }, { environment: 'PI_TELEMETRY=0' }],
    ['PI_CACHE_RETENTION', { environment: '' }, { environment: 'PI_CACHE_RETENTION=long' }],
    ['a first CLI path without saved inputs', {}, { cliPath: '/new/pi' }],
  ])('keeps native bindings and reloads when only %s changes', (label, before, after) => {
    const sessionEnvironment = 'PI_CODING_AGENT_SESSION_DIR=/sessions';
    const withSessionEnvironment = (inputs: PiFingerprintInputs): PiFingerprintInputs => (
      label.startsWith('a first') ? inputs : {
        ...inputs,
        environment: [sessionEnvironment, inputs.environment].filter(Boolean).join('\n'),
      }
    );
    const settings: Record<string, unknown> = {
      settingsProvider: 'pi',
      providerConfigs: { pi: toPiConfig(withSessionEnvironment(before)) },
    };
    piSettingsReconciler.reconcileModelWithEnvironment(settings, []);
    const conversation = createBoundPiConversation();
    (settings.providerConfigs as any).pi = {
      ...(settings.providerConfigs as any).pi,
      ...toPiConfig(withSessionEnvironment(after)),
    };

    const result = ProviderSettingsCoordinator.reconcileProviders(settings, [conversation], ['pi']);

    expect(result).toMatchObject({
      changed: true,
      environmentChangedProviderIds: ['pi'],
      invalidatedConversations: [],
      sessionInvalidationProviderIds: [],
    });
    expect(conversation).toEqual(createBoundPiConversation());
    expect(piSettingsReconciler.reconcileModelWithEnvironment(settings, [conversation]))
      .toEqual({ changed: false, invalidatedConversations: [] });
  });

  it.each([
    ['backfills without invalidating when runtime inputs are unchanged', '/same/pi', 'reload'],
    ['invalidates when runtime inputs also changed', '/new/pi', 'invalidate'],
  ] as const)('pre-split session fingerprint %s', (_label, nextCliPath, sessionPolicy) => {
    const settings: Record<string, unknown> = {
      providerConfigs: {
        pi: toPiConfig({ cliPath: '/same/pi', environment: 'PI_CODING_AGENT_DIR=/agent' }),
      },
    };
    piSettingsReconciler.reconcileModelWithEnvironment(settings, []);
    const config = (settings.providerConfigs as any).pi;
    const runtimeFingerprint = config.environmentHash;
    delete config.sessionEnvironmentHash;
    config.cliPath = nextCliPath;
    const conversation = createBoundPiConversation();

    const result = piSettingsReconciler.reconcileModelWithEnvironment(settings, [conversation]);

    const invalidates = sessionPolicy === 'invalidate';
    expect(result).toEqual({
      changed: true,
      invalidatedConversations: invalidates ? [conversation] : [],
      sessionPolicy,
    });
    expect(conversation.sessionId).toBe(invalidates ? null : 'current-session');
    expect(getPiProviderSettings(settings).sessionEnvironmentHash).toMatch(/^runtime-input:v1:/);
    expect(getPiProviderSettings(settings).environmentHash === runtimeFingerprint).toBe(!invalidates);
    expect(piSettingsReconciler.reconcileModelWithEnvironment(settings, []))
      .toEqual({ changed: false, invalidatedConversations: [] });
  });

  it('invalidates Pi conversations when Pi session/config environment changes', () => {
    const settings: Record<string, unknown> = {
      providerConfigs: {
        pi: {
          enabled: true,
          environmentHash: 'PI_CODING_AGENT_SESSION_DIR=/old',
          environmentVariables: 'PI_CODING_AGENT_SESSION_DIR=/new\nPI_OFFLINE=1',
        },
      },
    };
    const piConversation = {
      id: 'pi-conversation',
      messages: [],
      providerId: 'pi',
      providerState: {
        futureResumeCursor: { token: 'keep-me' },
        leafEntryId: 'assistant-1',
        sessionFile: '/old/session.jsonl',
      },
      sessionId: 'session-1',
    } as unknown as Conversation;
    const claudeConversation = {
      id: 'claude-conversation',
      messages: [],
      providerId: 'claude',
      providerState: { providerSessionId: 'claude-session' },
      sessionId: 'claude-session',
    } as unknown as Conversation;

    const result = piSettingsReconciler.reconcileModelWithEnvironment(
      settings,
      [piConversation, claudeConversation],
    );

    expect(result).toEqual({
      changed: true,
      invalidatedConversations: [piConversation],
      sessionPolicy: 'invalidate',
    });
    expect(piConversation.sessionId).toBeNull();
    expect(piConversation.providerState).toEqual({
      bindingRetired: true,
      futureResumeCursor: { token: 'keep-me' },
      previousSessions: [{
        leafEntryId: 'assistant-1',
        sessionFile: '/old/session.jsonl',
        sessionId: 'session-1',
      }],
    });
    expect(claudeConversation.sessionId).toBe('claude-session');
    const fingerprint = (settings.providerConfigs as any).pi.environmentHash;
    expect(isVersionedRuntimeInputFingerprint(fingerprint)).toBe(true);
    expect(fingerprint).not.toContain('/new');
  });

  it('migrates a matching legacy environment fingerprint before coordinator invalidation', () => {
    const settings: Record<string, unknown> = {
      providerConfigs: {
        pi: {
          enabled: true,
          environmentHash: 'PI_OFFLINE=1',
          environmentVariables: 'PI_OFFLINE=1',
        },
      },
    };
    const conversation = {
      id: 'pi-conversation',
      messages: [],
      providerId: 'pi',
      providerState: {
        leafEntryId: 'assistant-1',
        sessionFile: '/sessions/current.jsonl',
        sessionId: 'current-session',
      },
      sessionId: 'current-session',
    } as unknown as Conversation;

    expect(piSettingsReconciler.normalizeModelVariantSettings(settings)).toBe(true);
    const result = ProviderSettingsCoordinator.reconcileProviders(
      settings,
      [conversation],
      ['pi'],
    );

    expect(result).toMatchObject({
      changed: false,
      environmentChangedProviderIds: [],
      invalidatedConversations: [],
      sessionInvalidationProviderIds: [],
    });
    expect(conversation.sessionId).toBe('current-session');
    expect(conversation.providerState).toMatchObject({
      leafEntryId: 'assistant-1',
      sessionFile: '/sessions/current.jsonl',
      sessionId: 'current-session',
    });
    expect(isVersionedRuntimeInputFingerprint(
      (settings.providerConfigs as any).pi.environmentHash,
    )).toBe(true);
  });

  it('converts pending forks into replayable previous sessions idempotently', () => {
    const conversation = {
      id: 'pi-pending-fork',
      messages: [],
      providerId: 'pi',
      providerState: {
        forkSource: {
          resumeAt: 'assistant-1',
          sessionId: 'source-session',
        },
        forkSourceSessionFile: '/sessions/source.jsonl',
        futureResumeCursor: { token: 'keep-me' },
      },
      sessionId: null,
    } as unknown as Conversation;

    expect(piSettingsReconciler.invalidateConversationSessions([conversation])).toEqual([
      conversation,
    ]);
    expect(conversation.providerState).toEqual({
      bindingRetired: true,
      futureResumeCursor: { token: 'keep-me' },
      previousSessions: [{
        leafEntryId: 'assistant-1',
        sessionFile: '/sessions/source.jsonl',
        sessionId: 'source-session',
      }],
    });
    expect(piSettingsReconciler.invalidateConversationSessions([conversation])).toEqual([]);
  });

});
