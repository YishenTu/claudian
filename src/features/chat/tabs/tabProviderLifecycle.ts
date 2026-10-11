import { ProviderRegistry } from '@/core/providers/ProviderRegistry';
import type { ChatFeatureHost } from '@/features/chat/ChatFeatureHost';
import { resolveBlankTabReselection, type TabIdentity } from '@/features/chat/tabs/TabIdentity';
import { applyProviderUIGating, invalidateTabProviderCommands, refreshTabProviderUI, syncComposerDropdownForProvider } from '@/features/chat/tabs/tabProviderUI';
import type { AssembledTabRuntime, TabServices } from '@/features/chat/tabs/types';

export function syncTabProviderServices(
  tab: Pick<TabIdentity, 'providerId'>,
  services: TabServices,
): void {
  if (!tab.providerId) return;
  services.subagentManager.setTaskResultInterpreter(
    ProviderRegistry.getTaskResultInterpreter(tab.providerId),
  );
}

export function onProviderAvailabilityChanged(tab: AssembledTabRuntime, plugin: ChatFeatureHost): boolean {
  if (tab.conversationId !== null) return false;
  const selection = resolveBlankTabReselection(tab, plugin);
  if (selection) tab.session.selectDraft(selection.providerId, selection.draftModel);
  syncTabProviderServices(tab, tab.services);
  syncComposerDropdownForProvider(tab, plugin);
  invalidateTabProviderCommands(tab);
  refreshTabProviderUI(tab);
  applyProviderUIGating(tab, plugin);
  return selection !== null;
}
