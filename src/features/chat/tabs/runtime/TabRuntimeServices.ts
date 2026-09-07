import { ProviderRegistry } from '../../../../core/providers/ProviderRegistry';
import { SubagentManager } from '../../services/SubagentManager';
import { syncTabProviderServices } from '../TabProviderState';
import type { TabServices } from '../types';
import type {
  PublishedTabRuntimeRef,
  TabRuntimeConstructionContext,
  TabRuntimeShellBundle,
} from './TabRuntimeConstruction';

export function buildTabRuntimeServices(
  shell: TabRuntimeShellBundle,
  options: TabRuntimeConstructionContext,
  runtimeRef: PublishedTabRuntimeRef,
): TabServices {
  const subagentManager = new SubagentManager((subagent) => {
    runtimeRef.requirePublished().controllers.streamController.onAsyncSubagentStateChange(subagent);
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
    instructionRefineService: null,
    titleGenerationService,
  };
  options.registerCleanup('tab instruction refinement state', () => {
    services.instructionRefineService?.resetConversation();
  });
  options.registerCleanup('tab instruction refinement', () => {
    services.instructionRefineService?.cancel();
  });

  syncTabProviderServices(shell, services, options.plugin);
  return services;
}
