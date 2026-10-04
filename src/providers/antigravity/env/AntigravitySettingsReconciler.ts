import type { ProviderSettingsReconciler } from '@/core/providers/types';
import type { Conversation } from '@/core/types';

export const antigravitySettingsReconciler: ProviderSettingsReconciler = {
  invalidateConversationSessions(conversations: Conversation[]): Conversation[] {
    const invalidated: Conversation[] = [];
    for (const conversation of conversations) {
      if (conversation.providerId !== 'antigravity') continue;
      if (conversation.sessionId) {
        conversation.sessionId = null;
        conversation.providerState = undefined;
        invalidated.push(conversation);
      }
    }
    return invalidated;
  },

  reconcileModelWithEnvironment(
    _settings: Record<string, unknown>,
    _conversations: Conversation[],
  ): { changed: boolean; invalidatedConversations: Conversation[] } {
    return { changed: false, invalidatedConversations: [] };
  },
};
