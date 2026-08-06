import { ProviderWorkspaceRegistry } from '../../../core/providers/ProviderWorkspaceRegistry';
import type {
  ProviderWorkspaceRegistration,
  ProviderWorkspaceServices,
} from '../../../core/providers/types';
import { CursorModelDiscoveryService } from '../metadata/CursorModelDiscoveryService';
import { CursorCliResolver } from '../runtime/CursorCliResolver';
import { updateCursorProviderSettings } from '../settings';
import { cursorSettingsTabRenderer } from '../ui/CursorSettingsTab';

export interface CursorWorkspaceServices extends ProviderWorkspaceServices {
  cliResolver: CursorCliResolver;
  modelDiscoveryService: CursorModelDiscoveryService;
}

export const cursorWorkspaceRegistration: ProviderWorkspaceRegistration<CursorWorkspaceServices> = {
  initialize: async ({ plugin }) => {
    const modelDiscoveryService = new CursorModelDiscoveryService(plugin);
    return {
      cliResolver: new CursorCliResolver(),
      modelDiscoveryService,
      refreshModelCatalog: async () => {
        try {
          const catalog = await modelDiscoveryService.discoverCatalog();
          await plugin.mutateSettings(settings => {
            updateCursorProviderSettings(settings, {
              discoveredModels: catalog.models,
              catalogTimestamp: Date.now(),
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
      settingsTabRenderer: cursorSettingsTabRenderer,
    };
  },
};

export function maybeGetCursorWorkspaceServices(): CursorWorkspaceServices | null {
  return ProviderWorkspaceRegistry.getServices('cursor') as CursorWorkspaceServices | null;
}
