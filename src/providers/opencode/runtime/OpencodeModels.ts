import { createConfigCatalogStore, ProviderModelCatalogController } from '../../../core/providers/models/ProviderModelCatalog';
import type { ProviderRuntimeHost } from '../../../core/providers/ProviderRuntimeHost';
import { decodeOpencodeConfig, updateOpencodeConfig } from '../config';
import type { OpencodeMetadataService } from '../metadata/OpencodeMetadataService';
import { encodeOpencodeModelId, splitOpencodeModelLabel } from '../models';

export function createOpencodeModels(host: ProviderRuntimeHost, native: Pick<OpencodeMetadataService, 'discoverModels' | 'warmModelsMetadata'>): ProviderModelCatalogController {
  return new ProviderModelCatalogController({
    providerName: 'OpenCode',
    store: createConfigCatalogStore(host, {
      update: (config, _selection, patch) => { updateOpencodeConfig(config, patch); },
      read: config => {
        const current = decodeOpencodeConfig(config);
        return {
          enabled: current.enabled,
          models: [...current.discoveredModels].sort((left, right) => left.label.localeCompare(right.label)).map(model => {
            const { modelLabel, providerLabel } = splitOpencodeModelLabel(model.label || model.rawId);
            return {
              id: model.rawId,
              name: modelLabel,
              description: model.description,
              providerKey: model.rawId.split('/')[0],
              providerLabel,
            };
          }).reverse(),
          selectedIds: current.visibleModels,
          aliases: current.modelAliases,
        };
      },
    }),
    discover: signal => native.discoverModels(signal),
    async afterSelect(addedIds) {
      await native.warmModelsMetadata(addedIds.map(encodeOpencodeModelId));
    },
  });
}
