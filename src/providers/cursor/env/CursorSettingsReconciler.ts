import type { ProviderSettingsReconciler } from '../../../core/providers/types';
import type { Conversation } from '../../../core/types';
import { getCursorProviderSettings, updateCursorProviderSettings } from '../settings';

export const cursorSettingsReconciler: ProviderSettingsReconciler = {
  invalidateConversationSessions(conversations: Conversation[]): Conversation[] {
    return conversations.filter(conversation => conversation.providerId === 'cursor');
  },

  reconcileModelWithEnvironment(settings, _conversations) {
    const current = getCursorProviderSettings(settings);
    if (!current.environmentHash) return { changed: false, invalidatedConversations: [] };
    updateCursorProviderSettings(settings, { environmentHash: current.environmentHash });
    return { changed: false, invalidatedConversations: [] };
  },

  normalizeModelVariantSettings(): boolean { return false; },
};
