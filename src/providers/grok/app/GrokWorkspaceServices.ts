import type { ProviderCommandCatalog } from '../../../core/providers/commands/ProviderCommandCatalog';
import type { ProviderHost } from '../../../core/providers/ProviderHost';
import { ProviderWorkspaceRegistry } from '../../../core/providers/ProviderWorkspaceRegistry';
import type {
  ProviderTabWarmupPolicy,
  ProviderTransitionOwnerContext,
  ProviderWorkspaceRegistration,
  ProviderWorkspaceServices,
} from '../../../core/providers/types';
import { GrokAuxiliaryLifecycleCoordinator } from '../auxiliary/GrokAuxiliaryLifecycleCoordinator';
import { GrokCommandCatalog } from '../commands/GrokCommandCatalog';
import { GrokCliResolver } from '../runtime/GrokCliResolver';
import { GrokModelCatalogCoordinator } from '../runtime/GrokModelCatalogCoordinator';
import { GrokModelCatalogService } from '../runtime/GrokModelCatalogService';
import { grokSettingsTabRenderer } from '../ui/GrokSettingsTab';
import { GrokRuntimeCommandLoader } from './GrokRuntimeCommandLoader';

export interface GrokWorkspaceServices extends ProviderWorkspaceServices {
  auxiliaryLifecycle: GrokAuxiliaryLifecycleCoordinator;
  cliResolver: GrokCliResolver;
  commandCatalog: ProviderCommandCatalog;
  modelCatalogCoordinator: GrokModelCatalogCoordinator;
  refreshModelCatalog(
    context?: ProviderTransitionOwnerContext,
  ): ReturnType<GrokModelCatalogCoordinator['refreshModelCatalog']>;
  prepareSettings(): Promise<void>;
  dispose(): Promise<void>;
}

const grokTabWarmupPolicy: ProviderTabWarmupPolicy = {
  resolveMode() {
    return 'none';
  },
};

export async function createGrokWorkspaceServices(
  plugin: ProviderHost,
): Promise<GrokWorkspaceServices> {
  const modelCatalogService = new GrokModelCatalogService(plugin);
  const auxiliaryLifecycle = new GrokAuxiliaryLifecycleCoordinator();
  const modelCatalogCoordinator = new GrokModelCatalogCoordinator(
    plugin,
    modelCatalogService,
  );

  return {
    auxiliaryLifecycle,
    cliResolver: new GrokCliResolver(),
    commandCatalog: new GrokCommandCatalog(),
    modelCatalogCoordinator,
    runtimeCommandLoader: new GrokRuntimeCommandLoader(),
    settingsTabRenderer: grokSettingsTabRenderer,
    tabWarmupPolicy: grokTabWarmupPolicy,
    refreshModelCatalog: context => modelCatalogCoordinator.refreshModelCatalog(context),
    beginAuxiliaryServicesEnvironmentChange: () => (
      auxiliaryLifecycle.beginEnvironmentChange()
    ),
    async prepareSettings() {
      await modelCatalogCoordinator.ensureFresh('settings');
    },
    async dispose() {
      await auxiliaryLifecycle.dispose();
      modelCatalogCoordinator.dispose();
    },
  };
}

export const grokWorkspaceRegistration: ProviderWorkspaceRegistration<GrokWorkspaceServices> = {
  initialize: async ({ plugin }) => createGrokWorkspaceServices(plugin),
};

export function getGrokWorkspaceServices(): GrokWorkspaceServices {
  return ProviderWorkspaceRegistry.requireServices('grok') as GrokWorkspaceServices;
}

export async function resolveGrokAuxiliaryLifecycle(
  plugin: ProviderHost,
): Promise<GrokAuxiliaryLifecycleCoordinator> {
  await ProviderWorkspaceRegistry.ensureInitialized(plugin, 'grok', 'auxiliary-query');
  return getGrokWorkspaceServices().auxiliaryLifecycle;
}
