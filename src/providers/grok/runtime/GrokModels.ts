import { createConfigCatalogStore, ProviderModelCatalogController } from '../../../core/providers/models/ProviderModelCatalog';
import type { ProviderRuntimeHost } from '../../../core/providers/ProviderRuntimeHost';
import { decodeGrokConfig, getOrderedGrokVisibleModelIds, updateGrokConfig } from '../config';
import { getGrokModelLabel } from '../models';
import type { GrokModelCatalogCoordinator } from './GrokModelCatalogCoordinator';

export function createGrokModels(host: ProviderRuntimeHost, native: Pick<GrokModelCatalogCoordinator, 'refresh'>): ProviderModelCatalogController {
  return new ProviderModelCatalogController({
    providerName: 'Grok Build',
    store: createConfigCatalogStore(host, {
      update: updateGrokConfig,
      read: (config, selection) => {
        const current = decodeGrokConfig(config, selection);
        return {
          enabled: current.enabled,
          models: (current.currentCatalog?.models ?? []).map(model => ({
            id: model.rawId, name: getGrokModelLabel(model), description: model.description,
          })),
          selectedIds: getOrderedGrokVisibleModelIds(current),
          aliases: current.modelAliases,
        };
      },
    }),
    discover: async signal => {
      const result = await native.refresh(undefined, signal);
      return { changed: result.changed, diagnostics: result.diagnostics };
    },
  });
}
