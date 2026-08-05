import {
  createCliPathFingerprintInputs,
  hasCliPathFingerprintInputs,
} from '../../../core/providers/cli/CliPathFingerprintInputs';
import { getRuntimeEnvironmentText } from '../../../core/providers/providerEnvironment';
import {
  createRuntimeInputFingerprint,
  isVersionedRuntimeInputFingerprint,
} from '../../../core/providers/settings/RuntimeInputFingerprint';
import type { ProviderSettingsReconciler } from '../../../core/providers/types';
import type { Conversation } from '../../../core/types';
import { getHostnameKey, parseEnvironmentVariables } from '../../../utils/env';
import { resolveCodexModelSelection } from '../modelOptions';
import { getCodexProviderSettings, updateCodexProviderSettings } from '../settings';
import { getCodexState } from '../types';
import { codexChatUIConfig } from '../ui/CodexChatUIConfig';

const LEGACY_CODEX_ENV_HASH_KEYS = [
  'OPENAI_MODEL',
  'OPENAI_BASE_URL',
  'OPENAI_API_KEY',
] as const;
const ENV_HASH_KEYS = [...LEGACY_CODEX_ENV_HASH_KEYS, 'PATH'] as const;

export function computeCodexEnvHash(
  environmentText: string,
  additionalInputs: Readonly<Record<string, string | undefined>> = {},
): string {
  return createRuntimeInputFingerprint({
    additionalInputs,
    environmentKeys: ENV_HASH_KEYS,
    environmentText,
  });
}

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
  currentFingerprint: string;
  environmentText: string;
  hasFingerprintInputs: boolean;
  providerEnabled: boolean;
  savedFingerprint: string;
} {
  const environmentText = getRuntimeEnvironmentText(settings, 'codex');
  const codexSettings = getCodexProviderSettings(settings);
  const cliPathInputs = createCliPathFingerprintInputs(
    codexSettings.cliPathsByHost[getHostnameKey()],
    codexSettings.cliPath,
  );
  const additionalInputs = {
    ...cliPathInputs,
    installationMethod: codexSettings.installationMethod,
    wslDistroOverride: codexSettings.wslDistroOverride,
  };
  const environment = parseEnvironmentVariables(environmentText);
  return {
    currentFingerprint: computeCodexEnvHash(environmentText, additionalInputs),
    environmentText,
    hasFingerprintInputs: Boolean(
      hasCliPathFingerprintInputs(cliPathInputs)
      || codexSettings.installationMethod === 'wsl'
      || codexSettings.wslDistroOverride
      || ENV_HASH_KEYS.some(key => Object.prototype.hasOwnProperty.call(environment, key))
    ),
    providerEnabled: codexSettings.enabled,
    savedFingerprint: codexSettings.environmentHash,
  };
}

function invalidateCodexConversationSessions(conversations: Conversation[]): Conversation[] {
  const invalidatedConversations: Conversation[] = [];
  for (const conversation of conversations) {
    const state = getCodexState(conversation.providerState);
    if (conversation.providerId === 'codex' && (conversation.sessionId || state.threadId)) {
      conversation.sessionId = null;
      conversation.providerState = undefined;
      invalidatedConversations.push(conversation);
    }
  }
  return invalidatedConversations;
}

export const codexSettingsReconciler: ProviderSettingsReconciler = {
  invalidateConversationSessions: invalidateCodexConversationSessions,

  reconcileModelWithEnvironment(
    settings: Record<string, unknown>,
    conversations: Conversation[],
  ): { changed: boolean; invalidatedConversations: Conversation[] } {
    const fingerprint = getCodexRuntimeFingerprintState(settings);
    if (!fingerprint.savedFingerprint && !fingerprint.hasFingerprintInputs) {
      return { changed: false, invalidatedConversations: [] };
    }
    if (fingerprint.currentFingerprint === fingerprint.savedFingerprint) {
      return { changed: false, invalidatedConversations: [] };
    }

    const invalidatedConversations = invalidateCodexConversationSessions(conversations);

    const currentModel = typeof settings.model === 'string' ? settings.model : '';
    const nextModel = resolveCodexModelSelection(settings, currentModel);
    if (nextModel) {
      settings.model = nextModel;
    }

    updateCodexProviderSettings(settings, {
      environmentHash: fingerprint.currentFingerprint,
    });
    return { changed: true, invalidatedConversations };
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
        fingerprint.savedFingerprint,
      )
    ) {
      updateCodexProviderSettings(settings, {
        environmentHash: fingerprint.currentFingerprint,
      });
      changed = true;
    }

    const model = settings.model as string;
    if (!model) {
      return changed;
    }

    const normalizedModel = codexChatUIConfig.normalizeModelVariant(model, settings);
    if (normalizedModel === model) {
      return changed;
    }

    settings.model = normalizedModel;
    return true;
  },
};
