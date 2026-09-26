import { ProviderModelCatalogController } from '../../../core/providers/models/ProviderModelCatalog';
import type { ProviderHost } from '../../../core/providers/ProviderHost';
import type { OpencodeMetadataService } from '../metadata/OpencodeMetadataService';
import { buildOpencodeBaseModels, encodeOpencodeModelId, splitOpencodeModelLabel } from '../models';
import { getOpencodeProviderSettings, updateOpencodeProviderSettings } from '../settings';

export function createOpencodeModels(host: ProviderHost, native: Pick<OpencodeMetadataService, 'discoverModels' | 'warmModelsMetadata'>): ProviderModelCatalogController {
  return new ProviderModelCatalogController({
    providerId: 'opencode',
    host,
    update: updateOpencodeProviderSettings,
    providerName: 'OpenCode',
    read: () => {
      const current = getOpencodeProviderSettings(host.settings);
      return {
        enabled: current.enabled,
        models: buildOpencodeBaseModels(current.discoveredModels).map(model => {
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
    discover: async signal => {
      const loaded = await native.discoverModels(signal);
      return loaded ? { changed: true } : { changed: false, diagnostics: 'Could not load OpenCode models. Check the CLI path and login, then click Discover.' };
    },
    async afterSelect(addedIds) {
      await native.warmModelsMetadata(addedIds.map(encodeOpencodeModelId));
    },
  });
}
