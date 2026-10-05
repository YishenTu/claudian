import { ProviderRegistry } from '@/core/providers/ProviderRegistry';
import { ProviderWorkspaceRegistry } from '@/core/providers/ProviderWorkspaceRegistry';
import type { Conversation } from '@/core/types';
import type { ChatFeatureHost } from '@/features/chat/ChatFeatureHost';
import { getTabProviderId } from '@/features/chat/tabs/providerResolution';
import { reconcileBlankTabIdentity } from '@/features/chat/tabs/TabIdentity';
import { isClosingLifecycleState } from '@/features/chat/tabs/TabLifecycle';
import { applyProviderUIGating, invalidateTabProviderCommands, refreshTabProviderUI, refreshTabWorkspaceServices, syncComposerDropdownForProvider } from '@/features/chat/tabs/tabProviderUI';
import type { AssembledTabRuntime, TabProviderContext, TabServices } from '@/features/chat/tabs/types';
import { t } from '@/i18n/i18n';

export function createConversationExecutionBinding(conversation: Conversation) {
  return {
    conversationId: conversation.id,
    providerId: conversation.providerId,
    resumeSeed: {
      ...(conversation.sessionId ? { providerSessionId: conversation.sessionId } : {}),
      ...(conversation.providerState ? { providerState: conversation.providerState } : {}),
      ...(conversation.resumeAtMessageId
        ? { resumeCheckpoint: conversation.resumeAtMessageId }
        : {}),
    },
  };
}

export async function initializeTabExecution(
  tab: AssembledTabRuntime,
  plugin: ChatFeatureHost,
  conversationOverride?: Conversation | null,
): Promise<void> {
  if (tab.lifecycleState === 'closing') {
    return;
  }

  const conversation = conversationOverride ?? (
    tab.conversationId
      ? await plugin.getConversationById(tab.conversationId)
      : null
  );
  if (isClosingLifecycleState(tab.lifecycleState)) {
    return;
  }
  const providerId = getTabProviderId(tab, plugin, conversation);
  if (!providerId) throw new Error(t('chat.selectAvailableModel'));
  await ProviderWorkspaceRegistry.ensureInitialized(plugin.providerHost, providerId, 'tab-execution');
  if (isClosingLifecycleState(tab.lifecycleState)) {
    return;
  }
  refreshTabWorkspaceServices(tab, plugin);
  syncTabProviderServices(tab, tab.services);
  await tab.executionCoordinator.bindConversation(conversation
    ? createConversationExecutionBinding(conversation)
    : null);
  if (conversation) {
    await tab.executionCoordinator.prepare();
  }
}


export function syncTabProviderServices(
  tab: TabProviderContext,
  services: TabServices,
): void {
  if (!tab.providerId) return;
  services.subagentManager.setTaskResultInterpreter(
    ProviderRegistry.getTaskResultInterpreter(tab.providerId),
  );
}

export function onProviderAvailabilityChanged(tab: AssembledTabRuntime, plugin: ChatFeatureHost): boolean {
  if (tab.conversationId !== null) return false;
  const changed = reconcileBlankTabIdentity(tab, plugin);
  syncTabProviderServices(tab, tab.services);
  syncComposerDropdownForProvider(tab, plugin);
  invalidateTabProviderCommands(tab);
  refreshTabProviderUI(tab);
  applyProviderUIGating(tab, plugin);
  return changed;
}
