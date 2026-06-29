import { getRuntimeEnvironmentText } from '../../../core/providers/providerEnvironment';
import type { ProviderSettingsReconciler } from '../../../core/providers/types';
import type { Conversation } from '../../../core/types';
import { parseEnvironmentVariables } from '../../../utils/env';
import { getCodeBuddyProviderSettings, updateCodeBuddyProviderSettings } from '../settings';

const CODEBUDDY_ENV_HASH_KEYS = [
  'CODEBUDDY_HOME',
  'CODEBUDDY_CONFIG_DIR',
  'CODEBUDDY_DISABLE_AUTOUPDATE',
  'CODEBUDDY_DISABLE_COMPILE_CACHE',
] as const;

function computeCodeBuddyEnvHash(envText: string): string {
  const envVars = parseEnvironmentVariables(envText || '');
  return CODEBUDDY_ENV_HASH_KEYS
    .filter((key) => envVars[key])
    .map((key) => `${key}=${envVars[key]}`)
    .sort()
    .join('|');
}

export const codeBuddySettingsReconciler: ProviderSettingsReconciler = {
  handleEnvironmentChange(settings: Record<string, unknown>): boolean {
    const current = getCodeBuddyProviderSettings(settings);
    if (current.discoveredModels.length === 0) {
      return false;
    }
    updateCodeBuddyProviderSettings(settings, { discoveredModels: [] });
    return true;
  },

  reconcileModelWithEnvironment(
    settings: Record<string, unknown>,
    conversations: Conversation[],
  ): { changed: boolean; invalidatedConversations: Conversation[] } {
    const envText = getRuntimeEnvironmentText(settings, 'codebuddy');
    const currentHash = computeCodeBuddyEnvHash(envText);
    const savedHash = getCodeBuddyProviderSettings(settings).environmentHash;

    if (currentHash === savedHash) {
      return { changed: false, invalidatedConversations: [] };
    }

    const invalidatedConversations: Conversation[] = [];
    for (const conversation of conversations) {
      if (conversation.providerId !== 'codebuddy' || !conversation.sessionId) {
        continue;
      }
      conversation.sessionId = null;
      conversation.providerState = undefined;
      invalidatedConversations.push(conversation);
    }

    updateCodeBuddyProviderSettings(settings, { environmentHash: currentHash });
    return { changed: true, invalidatedConversations };
  },

  normalizeModelVariantSettings(): boolean {
    return false;
  },
};
