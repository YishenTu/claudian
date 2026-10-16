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
import { getClaudeProviderSettings, updateClaudeProviderSettings } from '../settings';
import { clearClaudeResumeState } from '../types/providerState';
import { CLAUDE_MODEL_ENV_KEYS } from './claudeModelEnv';

/** Session-scope with configured native home keys: changes invalidate bindings. */
const SESSION_ENV_KEYS = [...CLAUDE_MODEL_ENV_KEYS, 'ANTHROPIC_BASE_URL'];
/** Launch-only, like CLI paths: changes restart runtimes and keep bindings. */
const LAUNCH_ENV_KEYS = ['PATH'];
const NATIVE_HOME_ENV_KEYS = ['CLAUDE_CONFIG_DIR', 'HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH'];
const ALL_FINGERPRINT_ENV_KEYS = [...SESSION_ENV_KEYS, ...LAUNCH_ENV_KEYS, ...NATIVE_HOME_ENV_KEYS];

interface FingerprintInputs {
  environmentText: string;
  environment: Record<string, string>;
  cliPathInputs: CLIPathFingerprintInputs;
  savedFingerprint: string;
  savedSessionFingerprint: string;
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
    savedSessionFingerprint: claudeSettings.sessionEnvironmentHash,
  };
}

/** Keeps existing default-home fingerprints stable when no override is configured. */
function withConfiguredHomeKeys(keys: readonly string[], environment: Record<string, string>): string[] {
  return [
    ...keys,
    ...NATIVE_HOME_ENV_KEYS.filter(key => Object.prototype.hasOwnProperty.call(environment, key)),
  ];
}

function computeRuntimeFingerprint({ environmentText, environment, cliPathInputs }: FingerprintInputs): string {
  return createRuntimeInputFingerprint({
    additionalInputs: cliPathInputs,
    environmentKeys: withConfiguredHomeKeys([...SESSION_ENV_KEYS, ...LAUNCH_ENV_KEYS], environment),
    environmentText,
  });
}

function computeSessionFingerprint({ environmentText, environment }: Pick<FingerprintInputs, 'environment' | 'environmentText'>): string {
  return createRuntimeInputFingerprint({
    environmentKeys: withConfiguredHomeKeys(SESSION_ENV_KEYS, environment),
    environmentText,
  });
}

function computeFingerprints(inputs: FingerprintInputs): ScopedRuntimeInputFingerprints {
  return { runtime: computeRuntimeFingerprint(inputs), session: computeSessionFingerprint(inputs) };
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
  ): ProviderEnvironmentReconciliation {
    const inputs = readFingerprintInputs(settings);
    if (!inputs.savedFingerprint && !hasFingerprintInputs(inputs)) {
      return { changed: false, invalidatedConversations: [] };
    }
    if (isCurrentLegacyFingerprint(inputs)) {
      return { changed: false, invalidatedConversations: [] };
    }
    const current = computeFingerprints(inputs);
    const { changed, sessionPolicy } = compareScopedRuntimeInputFingerprints(
      { environmentHash: inputs.savedFingerprint, sessionEnvironmentHash: inputs.savedSessionFingerprint },
      current,
      computeSessionFingerprint({ environment: {}, environmentText: '' }),
    );
    if (!changed) {
      return { changed: false, invalidatedConversations: [] };
    }

    const invalidatedConversations = sessionPolicy === 'invalidate'
      ? invalidateClaudeConversationSessions(conversations)
      : [];

    updateClaudeProviderSettings(settings, {
      environmentHash: current.runtime,
      sessionEnvironmentHash: current.session,
    });
    return { changed: true, invalidatedConversations, sessionPolicy };
  },

  normalizeModelVariantSettings(settings: Record<string, unknown>): boolean {
    const inputs = readFingerprintInputs(settings);
    if (!isCurrentLegacyFingerprint(inputs)) return false;
    const current = computeFingerprints(inputs);
    updateClaudeProviderSettings(settings, {
      environmentHash: current.runtime,
      sessionEnvironmentHash: current.session,
    });
    return true;
  },
} satisfies ProviderSettingsReconciler;
