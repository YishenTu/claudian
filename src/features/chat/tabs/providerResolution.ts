import { getEnabledProviderForModel } from '../../../core/providers/modelRouting';
import type { ProviderId } from '../../../core/providers/types';
import type { Conversation } from '../../../core/types';
import type { FeatureHost } from '../../FeatureHost';
import type { TabProviderContext } from './types';

function getStoredConversationProviderId(
  tab: TabProviderContext,
  plugin: FeatureHost,
): ProviderId {
  if (tab.conversationId) {
    const conversation = plugin.getConversationSync(tab.conversationId);
    if (conversation?.providerId) {
      return conversation.providerId;
    }
  }

  if (tab.lifecycleState === 'blank' && tab.draftModel) {
    return getEnabledProviderForModel(
      tab.draftModel,
      plugin.settings,
    );
  }

  return tab.service?.providerId ?? tab.providerId;
}

export function getTabProviderId(
  tab: TabProviderContext,
  plugin: FeatureHost,
  conversation?: Conversation | null,
): ProviderId {
  return conversation?.providerId ?? getStoredConversationProviderId(tab, plugin);
}
