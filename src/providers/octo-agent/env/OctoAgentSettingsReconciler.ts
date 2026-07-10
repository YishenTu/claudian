import type { ProviderSettingsReconciler } from '../../../core/providers/types';
import type { Conversation } from '../../../core/types';
import { getOctoAgentProviderSettings } from '../settings';
import { octoAgentChatUIConfig } from '../ui/OctoAgentChatUIConfig';

export const octoAgentSettingsReconciler: ProviderSettingsReconciler = {
  handleEnvironmentChange(): boolean {
    return false;
  },

  reconcileModelWithEnvironment(
    settings: Record<string, unknown>,
    conversations: Conversation[],
  ): { changed: boolean; invalidatedConversations: Conversation[] } {
    const octoSettings = getOctoAgentProviderSettings(settings);
    const invalidatedConversations: Conversation[] = [];

    if (!octoSettings.enabled) {
      for (const conversation of conversations) {
        if (conversation.providerId === 'octo-agent' && conversation.sessionId) {
          conversation.sessionId = null;
          conversation.providerState = undefined;
          invalidatedConversations.push(conversation);
        }
      }
      return { changed: invalidatedConversations.length > 0, invalidatedConversations };
    }

    return { changed: false, invalidatedConversations };
  },

  normalizeModelVariantSettings(settings: Record<string, unknown>): boolean {
    const model = typeof settings.model === 'string' ? settings.model : '';
    if (!model || (!model.startsWith('octo-agent') && model !== 'octo-agent')) {
      return false;
    }
    const normalized = octoAgentChatUIConfig.normalizeModelVariant(model, settings);
    if (normalized !== model) {
      settings.model = normalized;
      return true;
    }
    return false;
  },
};
