import type { ProviderSettingsReconciler } from '../../../core/providers/types';
import type { Conversation } from '../../../core/types';
import { getOmpProviderSettings, updateOmpProviderSettings } from '../settings';

export const ompSettingsReconciler: ProviderSettingsReconciler = {
  invalidateConversationSessions(conversations: Conversation[]): Conversation[] {
    return conversations.filter(conversation => conversation.providerId === 'omp');
  },

  reconcileModelWithEnvironment(settings, _conversations) {
    const current = getOmpProviderSettings(settings);
    if (!current.environmentHash) return { changed: false, invalidatedConversations: [] };
    updateOmpProviderSettings(settings, { environmentHash: current.environmentHash });
    return { changed: false, invalidatedConversations: [] };
  },

  normalizeModelVariantSettings(): boolean { return false; },
};
