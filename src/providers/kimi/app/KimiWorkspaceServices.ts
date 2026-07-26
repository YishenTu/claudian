import type { ProviderCommandCatalog } from '../../../core/providers/commands/ProviderCommandCatalog';
import type { ProviderHost } from '../../../core/providers/ProviderHost';
import { ProviderWorkspaceRegistry } from '../../../core/providers/ProviderWorkspaceRegistry';
import type {
  ProviderModelCatalogRefreshResult,
  ProviderTabWarmupPolicy,
  ProviderTransitionOwnerContext,
  ProviderWorkspaceRegistration,
  ProviderWorkspaceServices,
} from '../../../core/providers/types';
import { KimiCommandCatalog } from '../commands/KimiCommandCatalog';
import { KimiCliResolver } from '../runtime/KimiCliResolver';
import { kimiSettingsTabRenderer } from '../ui/KimiSettingsTab';
import { refreshKimiModelCatalog } from './KimiModelCatalogRefresh';
import { KimiRuntimeCommandLoader } from './KimiRuntimeCommandLoader';

export interface KimiWorkspaceServices extends ProviderWorkspaceServices {
  commandCatalog: ProviderCommandCatalog;
  refreshModelCatalog(
    context?: ProviderTransitionOwnerContext,
  ): Promise<ProviderModelCatalogRefreshResult>;
}

const kimiTabWarmupPolicy: ProviderTabWarmupPolicy = {
  resolveMode() {
    return 'commands';
  },
};

async function createKimiWorkspaceServices(plugin: ProviderHost): Promise<KimiWorkspaceServices> {
  return {
    cliResolver: new KimiCliResolver(),
    commandCatalog: new KimiCommandCatalog(),
    refreshModelCatalog: () => refreshKimiModelCatalog(plugin),
    runtimeCommandLoader: new KimiRuntimeCommandLoader(),
    settingsTabRenderer: kimiSettingsTabRenderer,
    tabWarmupPolicy: kimiTabWarmupPolicy,
  };
}

export const kimiWorkspaceRegistration: ProviderWorkspaceRegistration<KimiWorkspaceServices> = {
  initialize: async ({ plugin }) => createKimiWorkspaceServices(plugin),
};

export function maybeGetKimiWorkspaceServices(): KimiWorkspaceServices | null {
  return ProviderWorkspaceRegistry.getServices('kimi') as KimiWorkspaceServices | null;
}
