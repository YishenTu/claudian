import type { ProviderId } from '@/core/providers/types';
import type { Conversation } from '@/core/types';
import type { ChatFeatureHost } from '@/features/chat/ChatFeatureHost';
import type { TabIdentity } from '@/features/chat/tabs/TabIdentity';
import { t } from '@/i18n/i18n';

function getStoredConversationProviderId(
  tab: Readonly<TabIdentity>,
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
  tab: Readonly<TabIdentity>,
  plugin: ChatFeatureHost,
  conversation?: Pick<Conversation, 'providerId'> | null,
): ProviderId | null {
  return conversation?.providerId ?? getStoredConversationProviderId(tab, plugin);
}

export function requireTabProviderId(tab: Readonly<TabIdentity>, plugin: ChatFeatureHost): ProviderId {
  const providerId = getTabProviderId(tab, plugin);
  if (!providerId) throw new Error(t('chat.selectAvailableModel'));
  return providerId;
}
