import { getRuntimeEnvironmentText } from '../../../core/providers/providerEnvironment';
import type { ProviderSettingsReconciler } from '../../../core/providers/types';
import type { Conversation } from '../../../core/types';
import { parseEnvironmentVariables } from '../../../utils/env';
import { getCodexProviderSettings, updateCodexProviderSettings } from '../settings';
import { getCodexState } from '../types';
import { codexChatUIConfig } from '../ui/CodexChatUIConfig';

const ENV_HASH_KEYS = ['OPENAI_MODEL', 'OPENAI_BASE_URL', 'OPENAI_API_KEY'];

function computeCodexEnvHash(envText: string): string {
  const envVars = parseEnvironmentVariables(envText || '');
  return ENV_HASH_KEYS
    .filter(key => envVars[key])
    .map(key => `${key}=${envVars[key]}`)
    .sort()
    .join('|');
}

export const codexSettingsReconciler: ProviderSettingsReconciler = {
  reconcileModelWithEnvironment(
    settings: Record<string, unknown>,
    conversations: Conversation[],
  ): { changed: boolean; invalidatedConversations: Conversation[] } {
    const envText = getRuntimeEnvironmentText(settings, 'codex');
    const currentHash = computeCodexEnvHash(envText);
    const savedHash = getCodexProviderSettings(settings).environmentHash;

    if (currentHash === savedHash) {
      return { changed: false, invalidatedConversations: [] };
    }

    const invalidatedConversations: Conversation[] = [];
    for (const conv of conversations) {
      const state = getCodexState(conv.providerState);
      if (conv.providerId === 'codex' && (conv.sessionId || state.threadId)) {
        conv.sessionId = null;
        conv.providerState = undefined;
        invalidatedConversations.push(conv);
      }
    }

    const envVars = parseEnvironmentVariables(envText || '');
    if (envVars.OPENAI_MODEL) {
      settings.model = envVars.OPENAI_MODEL;
    } else if (
      typeof settings.model === 'string'
      && settings.model.length > 0
      && !codexChatUIConfig.isDefaultModel(settings.model)
    ) {
      settings.model = codexChatUIConfig.getModelOptions({})[0]?.value ?? 'gpt-5.4';
    }

    updateCodexProviderSettings(settings, { environmentHash: currentHash });
    return { changed: true, invalidatedConversations };
  },

  normalizeModelVariantSettings(): boolean {
    return false;
  },
};
