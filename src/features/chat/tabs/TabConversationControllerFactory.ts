import { ProviderRegistry } from '../../../core/providers/ProviderRegistry';
import type { Conversation, ProviderId } from '../../../core/types';
import type { FeatureHost } from '../../FeatureHost';
import { ConversationController } from '../controllers/ConversationController';
import type { TabData } from './types';

export interface TabConversationControllerOptions {
  ensureExecutionInitialized: () => Promise<boolean>;
  getProviderId: () => ProviderId;
  getSelectedModel: () => string | null;
  onConversationBindingChanged: (conversation: Conversation | null) => Promise<void>;
  onNewConversation: () => void;
  onConversationActivated: () => void;
}

/**
 * Assembles ConversationController against the tab runtime. Conversation
 * binding remains a hook because provider settings, command catalogs, and
 * execution sessions must change as one tab-owned transaction.
 */
export function createTabConversationController(
  tab: TabData,
  plugin: FeatureHost,
  options: TabConversationControllerOptions,
): ConversationController {
  const { dom, state, services, ui } = tab;
  return new ConversationController(
    {
      plugin,
      state,
      renderer: tab.renderer!,
      subagentManager: services.subagentManager,
      getHistoryDropdown: () => null,
      getWelcomeEl: () => dom.welcomeEl,
      setWelcomeEl: (el) => { dom.welcomeEl = el; },
      getMessagesEl: () => dom.messagesEl,
      getInputEl: () => dom.inputEl,
      restoreMessageToComposer: message => (
        tab.controllers.inputController!.restoreRewoundMessageToComposer(message)
      ),
      getFileContextManager: () => ui.fileContextManager,
      getImageContextManager: () => ui.imageContextManager,
      getMcpServerSelector: () => ui.mcpServerSelector,
      getExternalContextSelector: () => ui.externalContextSelector,
      clearQueuedMessage: () => tab.controllers.inputController?.clearQueuedMessage(),
      getTitleGenerationService: () => services.titleGenerationService,
      getStatusPanel: () => ui.statusPanel,
      getExecutionCoordinator: () => tab.executionCoordinator,
      ensureExecutionInitialized: options.ensureExecutionInitialized,
      getProviderId: options.getProviderId,
      getSelectedModel: options.getSelectedModel,
      getInitialUsage: (providerId: ProviderId, model: string) => ProviderRegistry
        .getChatUIConfig(providerId)
        .getInitialUsage?.(model, plugin.settings) ?? null,
      dismissPendingInlinePrompts: () => tab.controllers.inputController?.dismissPendingApproval(),
      awaitBackgroundWork: () => tab.session.awaitBackgroundWork(),
      isDisposed: () => tab.lifecycleState === 'closing',
      ensureExecutionForConversation: options.onConversationBindingChanged,
    },
    {
      onNewConversation: options.onNewConversation,
      onConversationLoaded: options.onConversationActivated,
      onConversationSwitched: options.onConversationActivated,
    },
  );
}
