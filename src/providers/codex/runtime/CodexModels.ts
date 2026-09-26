import { ProviderModelCatalogController } from '../../../core/providers/models/ProviderModelCatalog';
import type { ProviderHost } from '../../../core/providers/ProviderHost';
import { isCodexModelAvailable } from '../models';
import { getCodexProviderSettings, getVisibleCodexModelIds, updateCodexProviderSettings } from '../settings';
import type { CodexModelCatalogCoordinator } from './CodexModelCatalogCoordinator';

export function createCodexModels(host: ProviderHost, native: Pick<CodexModelCatalogCoordinator, 'refresh'>): ProviderModelCatalogController {
  return new ProviderModelCatalogController({
    providerId: 'codex',
    host,
    update: updateCodexProviderSettings,
    providerName: 'Codex',
    read: () => {
      const current = getCodexProviderSettings(host.settings);
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
    discover: async signal => {
      const result = await native.refresh(undefined, signal);
      return { changed: result.refreshed, diagnostics: result.diagnostics };
    },
  });
}
