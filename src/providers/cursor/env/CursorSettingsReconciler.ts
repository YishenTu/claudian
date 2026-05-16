import { getRuntimeEnvironmentText } from '../../../core/providers/providerEnvironment';
import type { ProviderSettingsReconciler } from '../../../core/providers/types';
import type { Conversation } from '../../../core/types';
import { parseEnvironmentVariables } from '../../../utils/env';
import { resolveCursorModelSelection } from '../modelOptions';
import { getCursorProviderSettings, updateCursorProviderSettings } from '../settings';
import { getCursorState } from '../types';
import { cursorChatUIConfig } from '../ui/CursorChatUIConfig';

const ENV_HASH_KEYS = ['CURSOR_API_KEY', 'CURSOR_MODEL', 'CURSOR_BASE_URL'];

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
      if (conv.providerId === 'cursor' && (conv.sessionId || state.threadId)) {
        conv.sessionId = null;
        conv.providerState = undefined;
        invalidatedConversations.push(conv);
      }
    }

    const currentModel = typeof settings.model === 'string' ? settings.model : '';
    const nextModel = resolveCursorModelSelection(settings, currentModel);
    if (nextModel) {
      settings.model = nextModel;
    }

    updateCursorProviderSettings(settings, { environmentHash: currentHash });
    return { changed: true, invalidatedConversations };
  },

  normalizeModelVariantSettings(settings: Record<string, unknown>): boolean {
    const model = settings.model as string;
    if (!model) {
      return false;
    }

    const normalizedModel = cursorChatUIConfig.normalizeModelVariant(model, settings);
    if (normalizedModel === model) {
      return false;
    }

    settings.model = normalizedModel;
    return true;
  },
};
