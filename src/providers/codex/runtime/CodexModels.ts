import { createConfigCatalogStore, ProviderModelCatalogController } from '../../../core/providers/models/ProviderModelCatalog';
import type { ProviderRuntimeHost } from '../../../core/providers/ProviderRuntimeHost';
import { decodeCodexConfig, getVisibleCodexModelIds, updateCodexConfig } from '../config';
import { isCodexModelAvailable } from '../models';
import type { CodexModelCatalogCoordinator } from './CodexModelCatalogCoordinator';

export function createCodexModels(
  host: ProviderRuntimeHost,
  native: Pick<CodexModelCatalogCoordinator, 'refresh'>,
): ProviderModelCatalogController {
  return new ProviderModelCatalogController({
    providerName: 'Codex',
    store: createConfigCatalogStore(host, {
      update: (config, _selection, patch) => { updateCodexConfig(config, patch); },
      read: config => {
        const current = decodeCodexConfig(config);
        return {
          enabled: current.enabled,
          models: current.discoveredModels.map(model => ({
            id: model.model, name: model.displayName, description: model.description,
            isAvailable: isCodexModelAvailable(model, current.enableUltraEffort),
            unavailableMessage: 'Requires Ultra effort to be enabled',
          })),
          selectedIds: getVisibleCodexModelIds(current.visibleModels, current.discoveredModels),
          aliases: current.modelAliases,
        };
      },
    }),
    discover: async signal => {
      const result = await native.refresh(undefined, signal);
      return { changed: result.refreshed, diagnostics: result.diagnostics };
    },
  });
}
