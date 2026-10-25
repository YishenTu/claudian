import { getInstallationKey } from '@/core/device/InstallationKey';
import { parseEnvironmentVariables } from '@/core/process/env';

import {
  createCLIPathFingerprintInputs,
  hasCLIPathFingerprintInputs,
} from '../../../core/providers/cli/CLIPathFingerprintInputs';
import { getRuntimeEnvironmentText } from '../../../core/providers/providerEnvironment';
import {
  compareScopedRuntimeInputFingerprints,
  isVersionedRuntimeInputFingerprint,
  type SavedScopedRuntimeInputFingerprints,
  type ScopedRuntimeInputFingerprints,
} from '../../../core/providers/settings/RuntimeInputFingerprint';
import type {
  ProviderEnvironmentReconciliation,
  ProviderSettingsReconciler,
} from '../../../core/providers/types';
import type { Conversation } from '../../../core/types';
import { codexModelPolicy } from '../CodexModelPolicy';
import { DEFAULT_CODEX_PROVIDER_SETTINGS } from '../config';
import { resolveCodexModelSelection } from '../modelOptions';
import {
  CODEX_ENV_HASH_KEYS,
  type CodexInstallationInputs,
  computeCodexEnvHash,
  computeCodexSessionEnvHash,
  LEGACY_CODEX_ENV_HASH_KEYS,
} from '../runtime/codexEnvironmentHash';
import {
  getCodexProviderSettings,
  updateCodexProviderSettings,
} from '../settings';
import { clearCodexResumeState } from '../types';

function isCurrentLegacyCodexFingerprint(
  environmentText: string,
  savedFingerprint: string,
): boolean {
  if (isVersionedRuntimeInputFingerprint(savedFingerprint)) {
    return false;
  }

  const environment = parseEnvironmentVariables(environmentText);
  const legacyFingerprint = LEGACY_CODEX_ENV_HASH_KEYS
    .filter(key => environment[key])
    .map(key => `${key}=${environment[key]}`)
    .sort()
    .join('|');
  return savedFingerprint === legacyFingerprint;
}

function getCodexRuntimeFingerprintState(settings: Record<string, unknown>): {
  current: ScopedRuntimeInputFingerprints;
  environmentText: string;
  hasFingerprintInputs: boolean;
  providerEnabled: boolean;
  saved: SavedScopedRuntimeInputFingerprints;
} {
  const environmentText = getRuntimeEnvironmentText(settings, 'codex');
  const codexSettings = getCodexProviderSettings(settings);
  const cliPathInputs = createCLIPathFingerprintInputs(
    codexSettings.cliPathsByHost[getInstallationKey()],
    codexSettings.cliPath,
  );
  const installation: CodexInstallationInputs = {
    installationMethod: codexSettings.installationMethod,
    wslDistroOverride: codexSettings.wslDistroOverride,
  };
  const environment = parseEnvironmentVariables(environmentText);
  return {
    current: {
      runtime: computeCodexEnvHash(environmentText, { ...cliPathInputs, ...installation }),
      session: computeCodexSessionEnvHash(environmentText, installation),
    },
    environmentText,
    hasFingerprintInputs: Boolean(
      hasCLIPathFingerprintInputs(cliPathInputs)
      || codexSettings.installationMethod === 'wsl'
      || codexSettings.wslDistroOverride
      || CODEX_ENV_HASH_KEYS.some(key => Object.prototype.hasOwnProperty.call(environment, key))
    ),
    providerEnabled: codexSettings.enabled,
    saved: {
      environmentHash: codexSettings.environmentHash,
      sessionEnvironmentHash: codexSettings.sessionEnvironmentHash,
    },
  };
}

function invalidateCodexConversationSessions(conversations: Conversation[]): Conversation[] {
  return conversations.filter(conversation => (
    conversation.providerId === 'codex' && clearCodexResumeState(conversation)
  ));
}

export const codexSettingsReconciler = {
  invalidateConversationSessions: invalidateCodexConversationSessions,

  reconcileModelWithEnvironment(
    settings: Record<string, unknown>,
    conversations: Conversation[],
  ): ProviderEnvironmentReconciliation {
    const fingerprint = getCodexRuntimeFingerprintState(settings);
    if (!fingerprint.saved.environmentHash && !fingerprint.hasFingerprintInputs) {
      return { changed: false, invalidatedConversations: [] };
    }
    const { changed, sessionPolicy } = compareScopedRuntimeInputFingerprints(
      fingerprint.saved,
      fingerprint.current,
      computeCodexSessionEnvHash('', {
        installationMethod: DEFAULT_CODEX_PROVIDER_SETTINGS.installationMethod,
        wslDistroOverride: DEFAULT_CODEX_PROVIDER_SETTINGS.wslDistroOverride,
      }),
    );
    if (!changed) {
      return { changed: false, invalidatedConversations: [] };
    }

    const invalidatedConversations = sessionPolicy === 'invalidate'
      ? invalidateCodexConversationSessions(conversations)
      : [];

    const currentModel = typeof settings.model === 'string' ? settings.model : '';
    const nextModel = resolveCodexModelSelection(getCodexProviderSettings(settings), currentModel);
    if (nextModel) {
      settings.model = nextModel;
    }

    updateCodexProviderSettings(settings, {
      environmentHash: fingerprint.current.runtime,
      sessionEnvironmentHash: fingerprint.current.session,
    });
    return { changed: true, invalidatedConversations, sessionPolicy };
  },

  normalizeModelVariantSettings(settings: Record<string, unknown>): boolean {
    let changed = false;
    const fingerprint = getCodexRuntimeFingerprintState(settings);
    // Startup normalizes before reconciling. Upgrade an equivalent legacy
    // fingerprint here so the fingerprint schema change is not treated as a
    // runtime change that invalidates Codex sessions.
    if (
      (fingerprint.providerEnabled || fingerprint.hasFingerprintInputs)
      && isCurrentLegacyCodexFingerprint(
        fingerprint.environmentText,
        fingerprint.saved.environmentHash,
      )
    ) {
      updateCodexProviderSettings(settings, {
        environmentHash: fingerprint.current.runtime,
        sessionEnvironmentHash: fingerprint.current.session,
      });
      changed = true;
    }

    const model = settings.model as string;
    if (!model) {
      return changed;
    }

    const normalizedModel = codexModelPolicy.normalizeModelVariant(model, settings);
    if (normalizedModel === model) {
      return changed;
    }

    settings.model = normalizedModel;
    return true;
  },
} satisfies ProviderSettingsReconciler;
