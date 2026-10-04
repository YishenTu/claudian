import { getInstallationKey } from '@/core/device/InstallationKey';
import { parseEnvironmentVariables } from '@/core/process/env';

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
import { getClaudeProviderSettings, updateClaudeProviderSettings } from '../settings';
import { clearClaudeResumeState } from '../types/providerState';
import { CLAUDE_MODEL_ENV_KEYS } from './claudeModelEnv';

const ENV_HASH_PROVIDER_KEYS = ['ANTHROPIC_BASE_URL', 'PATH'];
const NATIVE_HOME_ENV_KEYS = ['CLAUDE_CONFIG_DIR', 'HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH'];
const ALL_FINGERPRINT_ENV_KEYS = [...CLAUDE_MODEL_ENV_KEYS, ...ENV_HASH_PROVIDER_KEYS, ...NATIVE_HOME_ENV_KEYS];

interface FingerprintInputs {
  environmentText: string;
  environment: Record<string, string>;
  cliPathInputs: CLIPathFingerprintInputs;
  savedFingerprint: string;
}

/** Reads every fingerprint input once per reconciliation. */
function readFingerprintInputs(settings: Record<string, unknown>): FingerprintInputs {
  const environmentText = getRuntimeEnvironmentText(settings, 'claude');
  const claudeSettings = getClaudeProviderSettings(settings);
  return {
    environmentText,
    environment: parseEnvironmentVariables(environmentText),
    cliPathInputs: createCLIPathFingerprintInputs(
      claudeSettings.cliPathsByHost[getInstallationKey()],
      claudeSettings.cliPath,
    ),
    savedFingerprint: claudeSettings.environmentHash,
  };
}

function computeRuntimeFingerprint({ environmentText, environment, cliPathInputs }: FingerprintInputs): string {
  return createRuntimeInputFingerprint({
    additionalInputs: cliPathInputs,
    // Keep existing default-home fingerprints stable when no override is configured.
    environmentKeys: ALL_FINGERPRINT_ENV_KEYS.filter(key => (
      !NATIVE_HOME_ENV_KEYS.includes(key) || Object.prototype.hasOwnProperty.call(environment, key)
    )),
    environmentText,
  });
}

function hasFingerprintInputs({ environment, cliPathInputs }: FingerprintInputs): boolean {
  return hasCLIPathFingerprintInputs(cliPathInputs)
    || ALL_FINGERPRINT_ENV_KEYS.some(key => Object.prototype.hasOwnProperty.call(environment, key));
}

/**
 * Unversioned fingerprints predate RuntimeInputFingerprint (#1024, 2026-08-03). Accepting a still-current
 * one lets it upgrade without invalidating sessions. Remove this branch after 2027-02-03, once settings
 * saved before #1024 are no longer migrated.
 */
function isCurrentLegacyFingerprint({ environment, cliPathInputs, savedFingerprint }: FingerprintInputs): boolean {
  if (
    !savedFingerprint
    || isVersionedRuntimeInputFingerprint(savedFingerprint)
    || hasCLIPathFingerprintInputs(cliPathInputs)
  ) {
    return false;
  }

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

export const claudeSettingsReconciler = {
  invalidateConversationSessions: invalidateClaudeConversationSessions,

  reconcileModelWithEnvironment(
    settings: Record<string, unknown>,
    conversations: Conversation[],
  ): { changed: boolean; invalidatedConversations: Conversation[] } {
    const inputs = readFingerprintInputs(settings);
    if (!inputs.savedFingerprint && !hasFingerprintInputs(inputs)) {
      return { changed: false, invalidatedConversations: [] };
    }
    if (isCurrentLegacyFingerprint(inputs)) {
      return { changed: false, invalidatedConversations: [] };
    }
    const currentFingerprint = computeRuntimeFingerprint(inputs);
    if (currentFingerprint === inputs.savedFingerprint) {
      return { changed: false, invalidatedConversations: [] };
    }

    const invalidatedConversations = invalidateClaudeConversationSessions(conversations);

    updateClaudeProviderSettings(settings, { environmentHash: currentFingerprint });
    return { changed: true, invalidatedConversations };
  },

  normalizeModelVariantSettings(settings: Record<string, unknown>): boolean {
    const inputs = readFingerprintInputs(settings);
    if (!isCurrentLegacyFingerprint(inputs)) return false;
    updateClaudeProviderSettings(settings, { environmentHash: computeRuntimeFingerprint(inputs) });
    return true;
  },
} satisfies ProviderSettingsReconciler;
