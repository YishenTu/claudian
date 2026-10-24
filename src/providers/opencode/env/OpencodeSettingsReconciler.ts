import { getInstallationKey } from '@/core/device/InstallationKey';
import { parseEnvironmentVariables } from '@/core/process/env';

import {
  type CLIPathFingerprintInputs,
  createCLIPathFingerprintInputs,
  hasCLIPathFingerprintInputs,
} from '../../../core/providers/cli/CLIPathFingerprintInputs';
import { getRuntimeEnvironmentText } from '../../../core/providers/providerEnvironment';
import { createRuntimeInputFingerprint } from '../../../core/providers/settings/RuntimeInputFingerprint';
import type { ProviderSettingsReconciler } from '../../../core/providers/types';
import type { Conversation } from '../../../core/types';
import {
  getOpencodeProviderSettings,
  updateOpencodeProviderSettings
} from '../settings';
import { clearOpencodeResumeState, getOpencodeState } from '../types';

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

/**
 * The one rule for what an environment change keeps: a binding resumes against its recorded
 * persistent database, including while the old launch drains, and a conversation without native
 * state has nothing to retire (a shared-runtime first run captures its database as it starts).
 * A binding without a recorded database would follow the new default, so it is retired. Whether
 * the native session still exists is answered by `opencode serve` at use time. The workspace hook
 * keeps running sessions by the same rule, so a kept session always keeps its binding.
 */
export function preservesOpencodeConversationSession(
  conversation: Pick<Conversation, 'sessionId' | 'providerState'>,
): boolean {
  const state = getOpencodeState(conversation.providerState);
  if (state.databasePath) return state.databasePath !== ':memory:';
  return !conversation.sessionId && !state.sessionId && !state.forkSource;
}

function invalidateOpencodeConversationSessions(conversations: Conversation[]): Conversation[] {
  const invalidatedConversations: Conversation[] = [];
  for (const conversation of conversations) {
    if (conversation.providerId !== 'opencode' || preservesOpencodeConversationSession(conversation)) {
      continue;
    }
    if (clearOpencodeResumeState(conversation, { releaseDatabase: true })) {
      invalidatedConversations.push(conversation);
    }
  }
  return invalidatedConversations;
}

export const opencodeSettingsReconciler = {

  invalidateConversationSessions: invalidateOpencodeConversationSessions,

  preservesConversationSession: preservesOpencodeConversationSession,

  reconcileModelWithEnvironment(
    settings: Record<string, unknown>,
    conversations: Conversation[],
  ): { changed: boolean; invalidatedConversations: Conversation[] } {
    const envText = getRuntimeEnvironmentText(settings, 'opencode');
    const opencodeSettings = getOpencodeProviderSettings(settings);
    const cliPathInputs = createCLIPathFingerprintInputs(
      opencodeSettings.cliPathsByHost[getInstallationKey()],
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
