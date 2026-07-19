import { createHash } from 'node:crypto';

import { getRuntimeEnvironmentText } from '../../../core/providers/providerEnvironment';
import type { ProviderSettingsReconciler } from '../../../core/providers/types';
import type { Conversation } from '../../../core/types';
import { parseEnvironmentVariables } from '../../../utils/env';
import { resolveCodexModelSelection } from '../modelOptions';
import { getCodexProviderSettings, updateCodexProviderSettings } from '../settings';
import { getCodexState } from '../types';
import { codexChatUIConfig } from '../ui/CodexChatUIConfig';

const ENV_HASH_KEYS = ['OPENAI_MODEL', 'OPENAI_BASE_URL', 'OPENAI_API_KEY'];

export function computeCodexEnvHash(envText: string): string {
  const envVars = parseEnvironmentVariables(envText || '');
  return ENV_HASH_KEYS
    .filter(key => envVars[key])
    // This value is persisted in the vault settings file. Never write model
    // endpoints or API keys into it verbatim; only a stable fingerprint is
    // needed to detect environment changes and invalidate stale sessions.
    .map(key => `${key}=${createHash('sha256').update(envVars[key]).digest('hex')}`)
    .sort()
    .join('|');
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
    const envText = getRuntimeEnvironmentText(settings, 'codex');
    const currentHash = computeCodexEnvHash(envText);
    const savedHash = getCodexProviderSettings(settings).environmentHash;

    if (currentHash === savedHash) {
      return { changed: false, invalidatedConversations: [] };
    }

    const invalidatedConversations = invalidateCodexConversationSessions(conversations);

    const currentModel = typeof settings.model === 'string' ? settings.model : '';
    const nextModel = resolveCodexModelSelection(settings, currentModel);
    if (nextModel) {
      settings.model = nextModel;
    }

    updateCodexProviderSettings(settings, { environmentHash: currentHash });
    return { changed: true, invalidatedConversations };
  },

  normalizeModelVariantSettings(settings: Record<string, unknown>): boolean {
    const model = settings.model as string;
    if (!model) {
      return false;
    }

    const normalizedModel = codexChatUIConfig.normalizeModelVariant(model, settings);
    if (normalizedModel === model) {
      return false;
    }

    settings.model = normalizedModel;
    return true;
  },
};
