import {
  type CLIPathFingerprintInputs,
  createCLIPathFingerprintInputs,
  hasCLIPathFingerprintInputs,
} from '../../../core/providers/cli/CLIPathFingerprintInputs';
import { getRuntimeEnvironmentText } from '../../../core/providers/providerEnvironment';
import {
  createRuntimeInputFingerprint,
  isVersionedRuntimeInputFingerprint,
} from '../../../core/providers/settings/RuntimeInputFingerprint';
import type { ProviderSettingsReconciler } from '../../../core/providers/types';
import type { Conversation } from '../../../core/types';
import { getHostnameKey, parseEnvironmentVariables } from '../../../utils/env';
import {
  getPiProviderSettings,
  updatePiProviderSettings
} from '../settings';
import { clearPiResumeState } from '../types';

const LEGACY_PI_ENV_HASH_KEYS = [
  'PI_CODING_AGENT_DIR',
  'PI_CODING_AGENT_SESSION_DIR',
  'PI_PACKAGE_DIR',
  'PI_OFFLINE',
  'PI_SKIP_VERSION_CHECK',
  'PI_TELEMETRY',
  'PI_CACHE_RETENTION',
] as const;

const PI_ENV_HASH_KEYS = [
  ...LEGACY_PI_ENV_HASH_KEYS,
  'PATH',
] as const;

function computePiRuntimeFingerprint(
  environmentText: string,
  cliPathInputs: CLIPathFingerprintInputs,
): string {
  return createRuntimeInputFingerprint({
    additionalInputs: cliPathInputs,
    environmentKeys: PI_ENV_HASH_KEYS,
    environmentText,
  });
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
  ): { changed: boolean; invalidatedConversations: Conversation[] } {
    const envText = getRuntimeEnvironmentText(settings, 'pi');
    const piSettings = getPiProviderSettings(settings);
    const cliPathInputs = createCLIPathFingerprintInputs(
      piSettings.cliPathsByHost[getHostnameKey()],
      piSettings.cliPath,
    );
    const currentHash = computePiRuntimeFingerprint(envText, cliPathInputs);
    const savedHash = piSettings.environmentHash;

    const environment = parseEnvironmentVariables(envText);
    const hasFingerprintInputs = Boolean(
      hasCLIPathFingerprintInputs(cliPathInputs)
      || PI_ENV_HASH_KEYS.some(key => Object.prototype.hasOwnProperty.call(environment, key))
    );
    if (!savedHash && !hasFingerprintInputs) {
      return { changed: false, invalidatedConversations: [] };
    }
    if (currentHash === savedHash) {
      return { changed: false, invalidatedConversations: [] };
    }

    const invalidatedConversations = invalidatePiConversationSessions(conversations);

    updatePiProviderSettings(settings, { environmentHash: currentHash });
    return { changed: true, invalidatedConversations };
  },

  normalizeModelVariantSettings(settings: Record<string, unknown>): boolean {
    const piSettings = getPiProviderSettings(settings);
    let changed = false;

    const envText = getRuntimeEnvironmentText(settings, 'pi');
    const cliPathInputs = createCLIPathFingerprintInputs(
      piSettings.cliPathsByHost[getHostnameKey()],
      piSettings.cliPath,
    );
    if (isCurrentLegacyPiFingerprint(
      envText,
      piSettings.environmentHash,
      cliPathInputs,
    )) {
      updatePiProviderSettings(settings, {
        environmentHash: computePiRuntimeFingerprint(envText, cliPathInputs),
      });
      changed = true;
    }

    return changed;
  },
} satisfies ProviderSettingsReconciler;
