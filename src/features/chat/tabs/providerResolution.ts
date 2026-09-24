import type { ProviderId } from '../../../core/providers/types';
import type { Conversation } from '../../../core/types';
import { t } from '../../../i18n/i18n';
import type { FeatureHost } from '../../FeatureHost';
import type { TabProviderContext } from './types';

function getStoredConversationProviderId(
  tab: TabProviderContext,
  plugin: FeatureHost,
): ProviderId | null {
  if (tab.conversationId) {
    const conversation = plugin.getConversationSync(tab.conversationId);
    if (conversation?.providerId) {
      return conversation.providerId;
    }
  }

  return tab.providerId;
}

export function getTabProviderId(
  tab: TabProviderContext,
  plugin: FeatureHost,
  conversation?: Conversation | null,
): ProviderId | null {
  return conversation?.providerId ?? getStoredConversationProviderId(tab, plugin);
}

export function requireTabProviderId(tab: TabProviderContext, plugin: FeatureHost): ProviderId {
  const providerId = getTabProviderId(tab, plugin);
  if (!providerId) throw new Error(t('chat.selectAvailableModel'));
  return providerId;
}
