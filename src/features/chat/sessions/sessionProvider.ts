import type { ProviderId } from '@/core/providers/types';
import type { Conversation } from '@/core/types';
import type { ChatFeatureHost } from '@/features/chat/ChatFeatureHost';
import type { SessionIdentity } from '@/features/chat/sessions/ChatSessionRuntime';
import { t } from '@/i18n/i18n';

function getStoredConversationProviderId(
  tab: Readonly<SessionIdentity>,
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

export function getSessionProviderId(
  tab: Readonly<SessionIdentity>,
  plugin: ChatFeatureHost,
  conversation?: Pick<Conversation, 'providerId'> | null,
): ProviderId | null {
  return conversation?.providerId ?? getStoredConversationProviderId(tab, plugin);
}

export function requireSessionProviderId(tab: Readonly<SessionIdentity>, plugin: ChatFeatureHost): ProviderId {
  const providerId = getSessionProviderId(tab, plugin);
  if (!providerId) throw new Error(t('chat.selectAvailableModel'));
  return providerId;
}
