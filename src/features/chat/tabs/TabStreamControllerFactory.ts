import { ProviderRegistry } from '../../../core/providers/ProviderRegistry';
import { getVaultPath } from '../../../utils/path';
import type { FeatureHost } from '../../FeatureHost';
import { StreamController } from '../controllers/StreamController';
import { getTabProviderId } from './providerResolution';
import type { TabData } from './types';

export type TabBackgroundWorkEnqueuer = (
  work: () => Promise<void>,
) => Promise<void> | null;

/**
 * Creates the stream controller for a tab from its already allocated runtime.
 * Provider history recovery stays behind the provider registry; the caller
 * supplies only the tab background-work queue adapter.
 */
export function createTabStreamController(
  tab: TabData,
  plugin: FeatureHost,
  enqueueBackgroundWork: TabBackgroundWorkEnqueuer,
): StreamController {
  const { dom, state, services, ui } = tab;
  return new StreamController({
    plugin,
    state,
    renderer: tab.renderer!,
    subagentManager: services.subagentManager,
    getMessagesEl: () => dom.messagesEl,
    getFileContextManager: () => ui.fileContextManager,
    updateQueueIndicator: () => tab.controllers.inputController?.updateQueueIndicator(),
    getProviderId: () => getTabProviderId(tab, plugin),
    getProviderSessionId: () => tab.executionCoordinator?.snapshot?.providerSessionId ?? null,
    loadSubagentToolCalls: async (request) => {
      const vaultPath = getVaultPath(plugin.app);
      if (!vaultPath) return undefined;
      const service = ProviderRegistry.createSubagentHistoryService(
        plugin.providerHost,
        request.providerId,
      );
      if (!service) return undefined;
      return service.loadToolCalls({
        providerSessionId: request.providerSessionId,
        subagentId: request.subagentId,
        vaultPath,
      });
    },
    loadSubagentFinalResult: async (request) => {
      const vaultPath = getVaultPath(plugin.app);
      if (!vaultPath) return undefined;
      const service = ProviderRegistry.createSubagentHistoryService(
        plugin.providerHost,
        request.providerId,
      );
      if (!service) return undefined;
      return service.loadFinalResult({
        providerSessionId: request.providerSessionId,
        subagentId: request.subagentId,
        vaultPath,
      });
    },
    enqueueBackgroundWork,
    persistConversation: async () => {
      if (tab.state.currentConversationId) {
        await tab.controllers.conversationController?.save(false);
      }
    },
  });
}
