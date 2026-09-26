import {
  type CLIPathFingerprintInputs,
  createCLIPathFingerprintInputs,
  hasCLIPathFingerprintInputs,
} from '../../../core/providers/cli/CLIPathFingerprintInputs';
import { getRuntimeEnvironmentText } from '../../../core/providers/providerEnvironment';
import { createRuntimeInputFingerprint } from '../../../core/providers/settings/RuntimeInputFingerprint';
import type { ProviderSettingsReconciler } from '../../../core/providers/types';
import type { Conversation } from '../../../core/types';
import { getHostnameKey, parseEnvironmentVariables } from '../../../utils/env';
import {
  getOpencodeProviderSettings,
  updateOpencodeProviderSettings
} from '../settings';
import { getOpencodeState } from '../types';

const OPENCODE_ENV_HASH_KEYS = [
  'OPENCODE_CONFIG',
  'OPENCODE_DB',
  'OPENCODE_DISABLE_PROJECT_CONFIG',
  'XDG_DATA_HOME',
  'PATH',
] as const;

function computeOpencodeRuntimeFingerprint(
  environmentText: string,
  cliPathInputs: CLIPathFingerprintInputs,
): string {
  return createRuntimeInputFingerprint({
    additionalInputs: cliPathInputs,
    environmentKeys: OPENCODE_ENV_HASH_KEYS,
    environmentText,
  });
}

function invalidateOpencodeConversationSessions(conversations: Conversation[]): Conversation[] {
  const invalidatedConversations: Conversation[] = [];
  for (const conversation of conversations) {
    if (conversation.providerId !== 'opencode') {
      continue;
    }

    const state = getOpencodeState(conversation.providerState);
    if (!conversation.sessionId && !state.databasePath) {
      continue;
    }

    conversation.sessionId = null;
    conversation.providerState = undefined;
    invalidatedConversations.push(conversation);
  }
  return invalidatedConversations;
}

export const opencodeSettingsReconciler = {

  invalidateConversationSessions: invalidateOpencodeConversationSessions,

  reconcileModelWithEnvironment(
    settings: Record<string, unknown>,
    conversations: Conversation[],
  ): { changed: boolean; invalidatedConversations: Conversation[] } {
    const envText = getRuntimeEnvironmentText(settings, 'opencode');
    const opencodeSettings = getOpencodeProviderSettings(settings);
    const cliPathInputs = createCLIPathFingerprintInputs(
      opencodeSettings.cliPathsByHost[getHostnameKey()],
      opencodeSettings.cliPath,
    );
    const currentHash = computeOpencodeRuntimeFingerprint(envText, cliPathInputs);
    const savedHash = opencodeSettings.environmentHash;

    const environment = parseEnvironmentVariables(envText);
    const hasFingerprintInputs = Boolean(
      hasCLIPathFingerprintInputs(cliPathInputs)
      || OPENCODE_ENV_HASH_KEYS.some(
        key => Object.prototype.hasOwnProperty.call(environment, key),
      )
    );
    if (!savedHash && !hasFingerprintInputs) {
      return { changed: false, invalidatedConversations: [] };
    }
    if (currentHash === savedHash) {
      return { changed: false, invalidatedConversations: [] };
    }

    const invalidatedConversations = invalidateOpencodeConversationSessions(conversations);

    updateOpencodeProviderSettings(settings, { environmentHash: currentHash });
    return { changed: true, invalidatedConversations };
  },

} satisfies ProviderSettingsReconciler;
