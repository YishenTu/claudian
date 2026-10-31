import '@/providers';

import { conversationRecord } from '@test/helpers/features/chat/ConversationFixture';

import { getInstallationKey } from '@/core/device/InstallationKey';
import { getProviderConfig, setProviderConfig } from '@/core/providers/providerConfig';
import { ProviderSettingsCoordinator } from '@/core/providers/ProviderSettingsCoordinator';
import { isVersionedRuntimeInputFingerprint } from '@/core/providers/settings/RuntimeInputFingerprint';
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

describe('piSettingsReconciler', () => {
  it('invalidates bindings on WSL distro changes and keeps them for process-only input changes', () => {
    const platform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    const config = { ...toPiConfig({}), installationMethodsByHost: { [getInstallationKey()]: 'wsl' }, wslDistroOverridesByHost: { [getInstallationKey()]: 'Ubuntu' } };
    const settings = { providerConfigs: { pi: config } };
    try {
      expect(piSettingsReconciler.reconcileModelWithEnvironment(settings)).toEqual({ changed: true, sessionPolicy: 'invalidate' });
      settings.providerConfigs.pi.wslDistroOverridesByHost[getInstallationKey()] = 'Debian';
      expect(piSettingsReconciler.reconcileModelWithEnvironment(settings)).toEqual({ changed: true, sessionPolicy: 'invalidate' });
      settings.providerConfigs.pi.environmentVariables = 'CUSTOM_API_TOKEN=updated';
      expect(piSettingsReconciler.reconcileModelWithEnvironment(settings)).toEqual({ changed: true, sessionPolicy: 'reload' });
    } finally { Object.defineProperty(process, 'platform', { value: platform, configurable: true }); }
  });

  it.each(['PI_CODING_AGENT_DIR', 'PI_CODING_AGENT_SESSION_DIR', 'PI_PACKAGE_DIR'])(
    'invalidates native bindings when location-affecting %s changes or is removed',
    key => {
      const settings: Record<string, unknown> = {
        providerConfigs: { pi: toPiConfig({ environment: `${key}=/old\nPI_OFFLINE=1` }) },
      };
      piSettingsReconciler.reconcileModelWithEnvironment(settings);
      for (const environment of [`${key}=/new\nPI_OFFLINE=1`, 'PI_OFFLINE=1']) {
        setProviderConfig(settings, 'pi', { ...getProviderConfig(settings, 'pi'), environmentVariables: environment });
        expect(piSettingsReconciler.reconcileModelWithEnvironment(settings))
          .toEqual({ changed: true, sessionPolicy: 'invalidate' });
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
    piSettingsReconciler.reconcileModelWithEnvironment(settings);
    (settings.providerConfigs as Record<string, unknown>).pi = {
      ...getProviderConfig(settings, 'pi'),
      ...toPiConfig(withSessionEnvironment(after)),
    };

    const result = ProviderSettingsCoordinator.reconcileProviders(settings, ['pi']);

    expect(result).toMatchObject({
      changed: true,
      environmentChangedProviderIds: ['pi'],
      sessionInvalidationProviderIds: [],
    });
    expect(piSettingsReconciler.reconcileModelWithEnvironment(settings)).toEqual({ changed: false });
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
    piSettingsReconciler.reconcileModelWithEnvironment(settings);
    const config = getProviderConfig(settings, 'pi');
    const runtimeFingerprint = config.environmentHash;
    delete config.sessionEnvironmentHash;
    config.cliPath = nextCliPath;
    setProviderConfig(settings, 'pi', config);

    const result = piSettingsReconciler.reconcileModelWithEnvironment(settings);

    expect(result).toEqual({ changed: true, sessionPolicy });
    expect(getPiProviderSettings(settings).sessionEnvironmentHash).toMatch(/^runtime-input:v1:/);
    expect(getPiProviderSettings(settings).environmentHash === runtimeFingerprint)
      .toBe(sessionPolicy === 'reload');
    expect(piSettingsReconciler.reconcileModelWithEnvironment(settings)).toEqual({ changed: false });
  });

  it('invalidates when Pi session/config environment changes and retires only Pi bindings', () => {
    const settings: Record<string, unknown> = {
      providerConfigs: {
        pi: {
          enabled: true,
          environmentHash: 'PI_CODING_AGENT_SESSION_DIR=/old',
          environmentVariables: 'PI_CODING_AGENT_SESSION_DIR=/new\nPI_OFFLINE=1',
        },
      },
    };
    const piConversation = conversationRecord('conversation', {
      id: 'pi-conversation',
      messages: [],
      providerId: 'pi',
      providerState: {
        futureResumeCursor: { token: 'keep-me' },
        leafEntryId: 'assistant-1',
        sessionFile: '/old/session.jsonl',
      },
      sessionId: 'session-1',
    });
    const claudeConversation = conversationRecord('conversation', {
      id: 'claude-conversation',
      messages: [],
      providerId: 'claude',
      providerState: { providerSessionId: 'claude-session' },
      sessionId: 'claude-session',
    });

    expect(piSettingsReconciler.reconcileModelWithEnvironment(settings))
      .toEqual({ changed: true, sessionPolicy: 'invalidate' });
    expect(piSettingsReconciler.invalidateConversationSessions([piConversation, claudeConversation]))
      .toEqual([piConversation]);
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
    const fingerprint = getProviderConfig(settings, 'pi').environmentHash;
    expect(isVersionedRuntimeInputFingerprint(fingerprint)).toBe(true);
    expect(fingerprint).not.toContain('/new');
  });

  it('migrates a matching legacy environment fingerprint without reporting a change', () => {
    const settings: Record<string, unknown> = {
      providerConfigs: {
        pi: {
          enabled: true,
          environmentHash: 'PI_OFFLINE=1',
          environmentVariables: 'PI_OFFLINE=1',
        },
      },
    };
    expect(piSettingsReconciler.normalizeModelVariantSettings(settings)).toBe(true);
    const result = ProviderSettingsCoordinator.reconcileProviders(settings, ['pi']);

    expect(result).toMatchObject({
      changed: false,
      environmentChangedProviderIds: [],
      sessionInvalidationProviderIds: [],
    });
    expect(isVersionedRuntimeInputFingerprint(
      getProviderConfig(settings, 'pi').environmentHash,
    )).toBe(true);
  });

  it('converts pending forks into replayable previous sessions idempotently', () => {
    const conversation = conversationRecord('conversation', {
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
    });

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
