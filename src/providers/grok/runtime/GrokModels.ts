import { ProviderModelCatalogController } from '../../../core/providers/models/ProviderModelCatalog';
import type { ProviderHost } from '../../../core/providers/ProviderHost';
import { getGrokProviderSettings, getOrderedGrokVisibleModelIds, updateGrokProviderSettings } from '../settings';
import type { GrokModelCatalogCoordinator } from './GrokModelCatalogCoordinator';

export function createGrokModels(host: ProviderHost, native: Pick<GrokModelCatalogCoordinator, 'refresh'>): ProviderModelCatalogController {
  return new ProviderModelCatalogController({
    providerId: 'grok',
    host,
    update: updateGrokProviderSettings,
    providerName: 'Grok',
    read: () => {
      const current = getGrokProviderSettings(host.settings);
      return {
        enabled: current.enabled,
        models: (current.currentCatalog?.models ?? []).map(model => ({
          id: model.rawId, name: model.displayName, description: model.description,
        })),
        selectedIds: getOrderedGrokVisibleModelIds(current),
        aliases: current.modelAliases,
      };
    },
    discover: async signal => {
      const result = await native.refresh(undefined, signal);
      return { changed: result.changed, diagnostics: result.diagnostics };
    },
  });
}
