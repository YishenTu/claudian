import { getRuntimeEnvironmentText } from '../../../core/providers/providerEnvironment';
import type { ProviderSettingsReconciler } from '../../../core/providers/types';
import type { Conversation } from '../../../core/types';
import { parseEnvironmentVariables } from '../../../utils/env';
import { getCursorProviderSettings, updateCursorProviderSettings } from '../settings';
import { getCursorState } from '../types';
import { cursorChatUIConfig } from '../ui/CursorChatUIConfig';

const ENV_HASH_KEYS = ['CURSOR_API_KEY', 'CURSOR_BASE_URL'];

function computeCursorEnvHash(envText: string): string {
  const envVars = parseEnvironmentVariables(envText || '');
  return ENV_HASH_KEYS
    .filter(key => envVars[key])
    .map(key => `${key}=${envVars[key]}`)
    .sort()
    .join('|');
}

export const cursorSettingsReconciler: ProviderSettingsReconciler = {
  reconcileModelWithEnvironment(
    settings: Record<string, unknown>,
    conversations: Conversation[],
  ): { changed: boolean; invalidatedConversations: Conversation[] } {
    const envText = getRuntimeEnvironmentText(settings, 'cursor');
    const currentHash = computeCursorEnvHash(envText);
    const savedHash = getCursorProviderSettings(settings).environmentHash;

    if (currentHash === savedHash) {
      return { changed: false, invalidatedConversations: [] };
    }

    const invalidatedConversations: Conversation[] = [];
    for (const conv of conversations) {
      const state = getCursorState(conv.providerState);
      if (conv.providerId === 'cursor' && (conv.sessionId || state.chatSessionId)) {
        conv.sessionId = null;
        conv.providerState = undefined;
        invalidatedConversations.push(conv);
      }
    }

    const envVars = parseEnvironmentVariables(envText || '');
    if (envVars.CURSOR_MODEL) {
      settings.model = envVars.CURSOR_MODEL;
    } else if (
      typeof settings.model === 'string'
      && settings.model.length > 0
      && !cursorChatUIConfig.isDefaultModel(settings.model)
    ) {
      settings.model = cursorChatUIConfig.getModelOptions({})[0]?.value ?? 'auto';
    }

    updateCursorProviderSettings(settings, { environmentHash: currentHash });
    return { changed: true, invalidatedConversations };
  },

  normalizeModelVariantSettings(): boolean {
    return false;
  },
};
