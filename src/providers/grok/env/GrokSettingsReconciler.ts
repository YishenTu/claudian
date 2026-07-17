import { getRuntimeEnvironmentText } from '../../../core/providers/providerEnvironment';
import type { ProviderSettingsReconciler } from '../../../core/providers/types';
import type { Conversation } from '../../../core/types';
import { parseEnvironmentVariables } from '../../../utils/env';
import { getGrokProviderSettings, updateGrokProviderSettings } from '../settings';
import { getGrokState } from '../types';
import { grokChatUIConfig } from '../ui/GrokChatUIConfig';

const GROK_ENV_HASH_KEYS = [
  'GROK_HOME',
  'GROK_MODEL',
  'XAI_MODEL',
  'XAI_API_KEY',
  'GROK_DEPLOYMENT_KEY',
] as const;

function computeGrokEnvHash(envText: string): string {
  const envVars = parseEnvironmentVariables(envText || '');
  return GROK_ENV_HASH_KEYS
    .filter((key) => envVars[key])
    .map((key) => `${key}=${envVars[key]}`)
    .sort()
    .join('|');
}

function invalidateGrokConversationSessions(conversations: Conversation[]): Conversation[] {
  const invalidatedConversations: Conversation[] = [];
  for (const conversation of conversations) {
    if (conversation.providerId !== 'grok') {
      continue;
    }

    const state = getGrokState(conversation.providerState);
    if (!conversation.sessionId && !state.sessionId) {
      continue;
    }

    conversation.sessionId = null;
    conversation.providerState = undefined;
    invalidatedConversations.push(conversation);
  }
  return invalidatedConversations;
}

export const grokSettingsReconciler: ProviderSettingsReconciler = {
  invalidateConversationSessions: invalidateGrokConversationSessions,

  reconcileModelWithEnvironment(
    settings: Record<string, unknown>,
    conversations: Conversation[],
  ): { changed: boolean; invalidatedConversations: Conversation[] } {
    const envText = getRuntimeEnvironmentText(settings, 'grok');
    const envVars = parseEnvironmentVariables(envText);
    const envModel = (envVars.GROK_MODEL || envVars.XAI_MODEL || '').trim();
    let changed = false;

    if (envModel && settings.model !== envModel) {
      settings.model = envModel;
      changed = true;
    }

    const currentHash = computeGrokEnvHash(envText);
    const savedHash = getGrokProviderSettings(settings).environmentHash;
    if (currentHash !== savedHash) {
      const invalidatedConversations = invalidateGrokConversationSessions(conversations);
      updateGrokProviderSettings(settings, { environmentHash: currentHash });
      return { changed: true, invalidatedConversations };
    }

    return { changed, invalidatedConversations: [] };
  },

  normalizeModelVariantSettings(settings: Record<string, unknown>): boolean {
    const model = typeof settings.model === 'string' ? settings.model : '';
    if (!model) {
      return false;
    }

    const normalizedModel = grokChatUIConfig.normalizeModelVariant(model, settings);
    if (normalizedModel === model) {
      return false;
    }

    settings.model = normalizedModel;
    return true;
  },
};
