import { ProviderRegistry } from '@/core/providers/ProviderRegistry';
import { SubagentManager } from '@/features/chat/subagents/SubagentManager';
import type {
  PublishedTabRuntimeRef,
  TabRuntimeConstructionContext,
  TabRuntimeShellBundle,
} from '@/features/chat/tabs/runtime/TabRuntimeConstruction';
import { syncTabProviderServices } from '@/features/chat/tabs/tabProviderLifecycle';
import type { TabServices } from '@/features/chat/tabs/types';

export function buildTabRuntimeServices(
  shell: TabRuntimeShellBundle,
  options: TabRuntimeConstructionContext,
  runtimeRef: PublishedTabRuntimeRef,
): TabServices {
  const subagentManager = new SubagentManager((subagent) => {
    runtimeRef.requirePublished().controllers.streamController.subagents.onAsyncSubagentStateChange(subagent);
    options.onWorkChanged?.(runtimeRef.requirePublished());
  });
  options.registerCleanup('tab subagent state', () => subagentManager.clear());

  const titleGenerationService = ProviderRegistry.createTitleGenerationService(
    options.plugin.providerHost,
  );
  options.registerCleanup(
    'tab title generation',
    () => titleGenerationService.cancel(),
  );

  const services: TabServices = {
    subagentManager,
    titleGenerationService,
  };
  syncTabProviderServices(shell, services);
  return services;
}
