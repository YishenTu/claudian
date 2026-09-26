import type { ProviderId } from '../../../core/providers/types';
import type { Conversation } from '../../../core/types';
import { t } from '../../../i18n/i18n';
import type { ChatFeatureHost } from '../ChatFeatureHost';
import type { TabProviderContext } from './types';

function getStoredConversationProviderId(
  tab: TabProviderContext,
  plugin: ChatFeatureHost,
): ProviderId | null {
  if (tab.conversationId) {
    const conversation = plugin.getConversationSummary(tab.conversationId);
    if (conversation?.providerId) {
      return conversation.providerId;
    }
  }

  return tab.providerId;
}

export function getTabProviderId(
  tab: TabProviderContext,
  plugin: ChatFeatureHost,
  conversation?: Pick<Conversation, 'providerId'> | null,
): ProviderId | null {
  return conversation?.providerId ?? getStoredConversationProviderId(tab, plugin);
}

export function requireTabProviderId(tab: TabProviderContext, plugin: ChatFeatureHost): ProviderId {
  const providerId = getTabProviderId(tab, plugin);
  if (!providerId) throw new Error(t('chat.selectAvailableModel'));
  return providerId;
}
