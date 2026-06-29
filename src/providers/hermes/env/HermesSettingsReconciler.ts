import { getRuntimeEnvironmentText } from '../../../core/providers/providerEnvironment';
import type { ProviderSettingsReconciler } from '../../../core/providers/types';
import type { Conversation } from '../../../core/types';
import { parseEnvironmentVariables } from '../../../utils/env';
import {
  getHermesProviderSettings,
  updateHermesProviderSettings,
} from '../settings';
import { getHermesProviderState } from '../types';

const HERMES_ENV_HASH_KEYS = [
  'HERMES_CONFIG',
  'HERMES_DB',
  'HERMES_HOME',
] as const;

function computeHermesEnvHash(envText: string): string {
  const envVars = parseEnvironmentVariables(envText || '');
  return HERMES_ENV_HASH_KEYS
    .filter((key) => envVars[key])
    .map((key) => `${key}=${envVars[key]}`)
    .sort()
    .join('|');
}

export const hermesSettingsReconciler: ProviderSettingsReconciler = {
  handleEnvironmentChange(settings: Record<string, unknown>): boolean {
    const envText = getRuntimeEnvironmentText(settings, 'hermes');
    const currentHash = computeHermesEnvHash(envText);
    const savedHash = getHermesProviderSettings(settings).environmentHash;

    if (currentHash === savedHash) {
      return false;
    }

    updateHermesProviderSettings(settings, { environmentHash: currentHash });
    return true;
  },

  reconcileModelWithEnvironment(
    settings: Record<string, unknown>,
    conversations: Conversation[],
  ): { changed: boolean; invalidatedConversations: Conversation[] } {
    const envText = getRuntimeEnvironmentText(settings, 'hermes');
    const currentHash = computeHermesEnvHash(envText);
    const savedHash = getHermesProviderSettings(settings).environmentHash;

    if (currentHash === savedHash) {
      return { changed: false, invalidatedConversations: [] };
    }

    const invalidatedConversations: Conversation[] = [];
    for (const conversation of conversations) {
      if (conversation.providerId !== 'hermes') {
        continue;
      }

      const state = getHermesProviderState(conversation.providerState);
      if (!conversation.sessionId && !state.sessionId) {
        continue;
      }

      conversation.sessionId = null;
      conversation.providerState = undefined;
      invalidatedConversations.push(conversation);
    }

    updateHermesProviderSettings(settings, { environmentHash: currentHash });
    return { changed: true, invalidatedConversations };
  },

  normalizeModelVariantSettings(
    _settings: Record<string, unknown>,
  ): boolean {
    return false;
  },
};
