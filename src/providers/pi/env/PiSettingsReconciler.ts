import { getInstallationKey } from '@/core/device/InstallationKey';
import { parseEnvironmentVariables } from '@/core/process/env';

import {
  type CLIPathFingerprintInputs,
  createCLIPathFingerprintInputs,
  hasCLIPathFingerprintInputs,
} from '../../../core/providers/cli/CLIPathFingerprintInputs';
import { getRuntimeEnvironmentText } from '../../../core/providers/providerEnvironment';
import {
  compareScopedRuntimeInputFingerprints,
  createRuntimeInputFingerprint,
  isVersionedRuntimeInputFingerprint,
  type ScopedRuntimeInputFingerprints,
} from '../../../core/providers/settings/RuntimeInputFingerprint';
import type {
  ProviderEnvironmentReconciliation,
  ProviderSettingsReconciler,
} from '../../../core/providers/types';
import type { Conversation } from '../../../core/types';
import {
  getPiProviderSettings,
  updatePiProviderSettings
} from '../settings';
import { clearPiResumeState } from '../types';

/**
 * Select the native config/session store; `PI_PACKAGE_DIR` can rename the default config dir.
 * Changes invalidate bindings.
 */
const PI_SESSION_ENV_KEYS = [
  'PI_CODING_AGENT_DIR',
  'PI_CODING_AGENT_SESSION_DIR',
  'PI_PACKAGE_DIR',
] as const;

const LEGACY_PI_ENV_HASH_KEYS = [
  ...PI_SESSION_ENV_KEYS,
  'PI_OFFLINE',
  'PI_SKIP_VERSION_CHECK',
  'PI_TELEMETRY',
  'PI_CACHE_RETENTION',
] as const;

/**
 * Non-session keys and CLI paths only affect the launched process. Resume targets an absolute
 * session file whose identity is proved before input, so changes restart runtimes and keep bindings.
 */
const PI_ENV_HASH_KEYS = [
  ...LEGACY_PI_ENV_HASH_KEYS,
  'PATH',
] as const;

function computePiFingerprints(
  environmentText: string,
  cliPathInputs: CLIPathFingerprintInputs,
): ScopedRuntimeInputFingerprints {
  return {
    runtime: createRuntimeInputFingerprint({
      additionalInputs: cliPathInputs,
      environmentKeys: PI_ENV_HASH_KEYS,
      environmentText,
    }),
    session: computePiSessionFingerprint(environmentText),
  };
}

function computePiSessionFingerprint(environmentText: string): string {
  return createRuntimeInputFingerprint({ environmentKeys: PI_SESSION_ENV_KEYS, environmentText });
}

function invalidatePiConversationSessions(conversations: Conversation[]): Conversation[] {
  return conversations.filter(conversation => (
    conversation.providerId === 'pi' && clearPiResumeState(conversation)
  ));
}

function isCurrentLegacyPiFingerprint(
  environmentText: string,
  savedFingerprint: string,
  cliPathInputs: CLIPathFingerprintInputs,
): boolean {
  if (
    !savedFingerprint
    || isVersionedRuntimeInputFingerprint(savedFingerprint)
    || hasCLIPathFingerprintInputs(cliPathInputs)
  ) {
    return false;
  }

  const environment = parseEnvironmentVariables(environmentText);
  const legacyFingerprint = LEGACY_PI_ENV_HASH_KEYS
    .filter(key => environment[key])
    .map(key => `${key}=${environment[key]}`)
    .sort()
    .join('|');
  return savedFingerprint === legacyFingerprint;
}

export const piSettingsReconciler = {

  invalidateConversationSessions: invalidatePiConversationSessions,

  reconcileModelWithEnvironment(
    settings: Record<string, unknown>,
    conversations: Conversation[],
  ): ProviderEnvironmentReconciliation {
    const envText = getRuntimeEnvironmentText(settings, 'pi');
    const piSettings = getPiProviderSettings(settings);
    const cliPathInputs = createCLIPathFingerprintInputs(
      piSettings.cliPathsByHost[getInstallationKey()],
      piSettings.cliPath,
    );
    const savedHash = piSettings.environmentHash;

    const environment = parseEnvironmentVariables(envText);
    const hasFingerprintInputs = Boolean(
      hasCLIPathFingerprintInputs(cliPathInputs)
      || PI_ENV_HASH_KEYS.some(key => Object.prototype.hasOwnProperty.call(environment, key))
    );
    if (!savedHash && !hasFingerprintInputs) {
      return { changed: false, invalidatedConversations: [] };
    }
    const current = computePiFingerprints(envText, cliPathInputs);
    const { changed, sessionPolicy } = compareScopedRuntimeInputFingerprints(
      { environmentHash: savedHash, sessionEnvironmentHash: piSettings.sessionEnvironmentHash },
      current,
      computePiSessionFingerprint(''),
    );
    if (!changed) {
      return { changed: false, invalidatedConversations: [] };
    }

    const invalidatedConversations = sessionPolicy === 'invalidate'
      ? invalidatePiConversationSessions(conversations)
      : [];

    updatePiProviderSettings(settings, {
      environmentHash: current.runtime,
      sessionEnvironmentHash: current.session,
    });
    return { changed: true, invalidatedConversations, sessionPolicy };
  },

  normalizeModelVariantSettings(settings: Record<string, unknown>): boolean {
    const piSettings = getPiProviderSettings(settings);
    let changed = false;

    const envText = getRuntimeEnvironmentText(settings, 'pi');
    const cliPathInputs = createCLIPathFingerprintInputs(
      piSettings.cliPathsByHost[getInstallationKey()],
      piSettings.cliPath,
    );
    if (isCurrentLegacyPiFingerprint(
      envText,
      piSettings.environmentHash,
      cliPathInputs,
    )) {
      const current = computePiFingerprints(envText, cliPathInputs);
      updatePiProviderSettings(settings, {
        environmentHash: current.runtime,
        sessionEnvironmentHash: current.session,
      });
      changed = true;
    }

    return changed;
  },
} satisfies ProviderSettingsReconciler;
