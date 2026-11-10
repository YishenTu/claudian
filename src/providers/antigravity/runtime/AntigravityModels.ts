import { createConfigCatalogStore, ProviderModelCatalogController } from '../../../core/providers/models/ProviderModelCatalog';
import type { ProviderRuntimeHost } from '../../../core/providers/ProviderRuntimeHost';
import { decodeAntigravityConfig, getOrderedAntigravityVisibleModelIds, updateAntigravityConfig } from '../config';
import type { AntigravityModelCatalog } from './AntigravityModelCatalog';

export function createAntigravityModels(
  host: ProviderRuntimeHost,
  catalog: Pick<AntigravityModelCatalog, 'refresh'>,
): ProviderModelCatalogController {
  return new ProviderModelCatalogController({
    providerName: 'Antigravity',
    store: createConfigCatalogStore(host, {
      update: updateAntigravityConfig,
      read: (config, selection) => {
        const current = decodeAntigravityConfig(config, selection);
        return {
          aliases: current.modelAliases,
          enabled: current.enabled,
          models: (current.currentCatalog?.models ?? []).map(model => ({ id: model.rawId, name: model.displayName })),
          selectedIds: getOrderedAntigravityVisibleModelIds(current),
        };
      },
    }),
    discover: signal => catalog.refresh(signal),
  });
}
