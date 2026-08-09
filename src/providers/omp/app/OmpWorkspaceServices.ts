import { ProviderWorkspaceRegistry } from '../../../core/providers/ProviderWorkspaceRegistry';
import type {
  ProviderWorkspaceRegistration,
  ProviderWorkspaceServices,
} from '../../../core/providers/types';
import { OmpModelDiscoveryService } from '../metadata/OmpModelDiscoveryService';
import { OmpCliResolver } from '../runtime/OmpCliResolver';
import { getOmpProviderSettings, updateOmpProviderSettings } from '../settings';
import { ompSettingsTabRenderer } from '../ui/OmpSettingsTab';

export interface OmpWorkspaceServices extends ProviderWorkspaceServices {
  cliResolver: OmpCliResolver;
  modelDiscoveryService: OmpModelDiscoveryService;
}

export const ompWorkspaceRegistration: ProviderWorkspaceRegistration<OmpWorkspaceServices> = {
  initialize: async ({ plugin }) => {
    const modelDiscoveryService = new OmpModelDiscoveryService(plugin);
    return {
      cliResolver: new OmpCliResolver(),
      modelDiscoveryService,
      refreshModelCatalog: async () => {
        try {
          const catalog = await modelDiscoveryService.discoverCatalog();
          await plugin.mutateSettings(settings => {
            const current = getOmpProviderSettings(settings);
            updateOmpProviderSettings(settings, {
              discoveredModels: catalog.models,
              catalogTimestamp: Date.now(),
              visibleModels: current.visibleModels.length > 0
                ? current.visibleModels
                : catalog.models[0]
                  ? [catalog.models[0].rawId]
                  : [],
              ...(catalog.thinking ? { thinking: catalog.thinking } : {}),
            });
          });
          return { changed: true };
        } catch (error) {
          return {
            changed: false,
            diagnostics: error instanceof Error ? error.message : String(error),
          };
        }
      },
      settingsTabRenderer: ompSettingsTabRenderer,
    };
  },
};

export function maybeGetOmpWorkspaceServices(): OmpWorkspaceServices | null {
  return ProviderWorkspaceRegistry.getServices('omp') as OmpWorkspaceServices | null;
}
