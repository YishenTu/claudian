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
import { getClaudeProviderSettings, updateClaudeProviderSettings } from '../settings';
import { clearClaudeResumeState } from '../types/providerState';
import { CLAUDE_MODEL_ENV_KEYS } from './claudeModelEnv';

const ENV_HASH_PROVIDER_KEYS = ['ANTHROPIC_BASE_URL', 'PATH'];
const NATIVE_HOME_ENV_KEYS = ['CLAUDE_CONFIG_DIR', 'HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH'];
const ALL_FINGERPRINT_ENV_KEYS = [...CLAUDE_MODEL_ENV_KEYS, ...ENV_HASH_PROVIDER_KEYS, ...NATIVE_HOME_ENV_KEYS];

function getConfiguredCLIPathInputs(
  settings: Record<string, unknown>,
): CLIPathFingerprintInputs {
  const claudeSettings = getClaudeProviderSettings(settings);
  return createCLIPathFingerprintInputs(
    claudeSettings.cliPathsByHost[getHostnameKey()],
    claudeSettings.cliPath,
  );
}

function computeRuntimeFingerprint(
  settings: Record<string, unknown>,
  environmentText: string = getRuntimeEnvironmentText(settings, 'claude'),
): string {
  const environment = parseEnvironmentVariables(environmentText);
  return createRuntimeInputFingerprint({
    additionalInputs: getConfiguredCLIPathInputs(settings),
    // Keep existing default-home fingerprints stable when no override is configured.
    environmentKeys: ALL_FINGERPRINT_ENV_KEYS.filter(key => (
      !NATIVE_HOME_ENV_KEYS.includes(key) || Object.prototype.hasOwnProperty.call(environment, key)
    )),
    environmentText,
  });
}

function hasFingerprintInputs(settings: Record<string, unknown>, environmentText: string): boolean {
  if (hasCLIPathFingerprintInputs(getConfiguredCLIPathInputs(settings))) {
    return true;
  }

  const environment = parseEnvironmentVariables(environmentText);
  return ALL_FINGERPRINT_ENV_KEYS
    .some(key => Object.prototype.hasOwnProperty.call(environment, key));
}

function isCurrentLegacyFingerprint(
  settings: Record<string, unknown>,
  environmentText: string,
  savedFingerprint: string,
): boolean {
  if (
    !savedFingerprint
    || isVersionedRuntimeInputFingerprint(savedFingerprint)
    || hasCLIPathFingerprintInputs(getConfiguredCLIPathInputs(settings))
  ) {
    return false;
  }

  const environment = parseEnvironmentVariables(environmentText);
  const legacyFingerprint = ALL_FINGERPRINT_ENV_KEYS
    .filter(key => environment[key])
    .map(key => `${key}=${environment[key]}`)
    .sort()
    .join('|');
  return savedFingerprint === legacyFingerprint;
}

function invalidateClaudeConversationSessions(conversations: Conversation[]): Conversation[] {
  return conversations.filter(conv => (
    conv.providerId === 'claude' && clearClaudeResumeState(conv)
  ));
}

export const claudeSettingsReconciler: ProviderSettingsReconciler = {
  invalidateConversationSessions: invalidateClaudeConversationSessions,

  reconcileModelWithEnvironment(
    settings: Record<string, unknown>,
    conversations: Conversation[],
  ): { changed: boolean; invalidatedConversations: Conversation[] } {
    const envText = getRuntimeEnvironmentText(settings, 'claude');
    const currentHash = computeRuntimeFingerprint(settings, envText);
    const savedHash = getClaudeProviderSettings(settings).environmentHash;

    if (!savedHash && !hasFingerprintInputs(settings, envText)) {
      return { changed: false, invalidatedConversations: [] };
    }
    if (isCurrentLegacyFingerprint(settings, envText, savedHash)) {
      return { changed: false, invalidatedConversations: [] };
    }
    if (currentHash === savedHash) {
      return { changed: false, invalidatedConversations: [] };
    }

    const invalidatedConversations = invalidateClaudeConversationSessions(conversations);

    updateClaudeProviderSettings(settings, { environmentHash: currentHash });
    return { changed: true, invalidatedConversations };
  },

  normalizeModelVariantSettings(settings: Record<string, unknown>): boolean {
    const config = getClaudeProviderSettings(settings);
    const environmentText = getRuntimeEnvironmentText(settings, 'claude');
    if (!isCurrentLegacyFingerprint(settings, environmentText, config.environmentHash)) return false;
    updateClaudeProviderSettings(settings, { environmentHash: computeRuntimeFingerprint(settings, environmentText) });
    return true;
  },
};
