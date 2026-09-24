import { ProviderModelCatalogController } from '../../../core/providers/models/ProviderModelCatalog';
import type { ProviderHost } from '../../../core/providers/ProviderHost';
import { findClaudeModelOption, getClaudeModelCatalog, getClaudeVisibleModelIds } from '../modelOptions';
import { toClaudeRuntimeModelId } from '../modelSelection';
import { getClaudeProviderSettings, updateClaudeProviderSettings } from '../settings';
import type { ClaudeModelCatalog } from './ClaudeModelCatalog';

export function createClaudeModels(host: ProviderHost, native: Pick<ClaudeModelCatalog, 'refresh'>): ProviderModelCatalogController {
  return new ProviderModelCatalogController({
    providerId: 'claude',
    host,
    update: updateClaudeProviderSettings,
    providerName: 'Claude',
    read: () => {
      const current = getClaudeProviderSettings(host.settings);
      const models = getClaudeModelCatalog(host.settings);
      return {
        enabled: current.enabled,
        models: models.map(model => ({
          id: toClaudeRuntimeModelId(model.value), name: model.label, description: model.description,
        })),
        selectedIds: getClaudeVisibleModelIds(host.settings).map(id =>
          toClaudeRuntimeModelId(findClaudeModelOption(models, id)?.value ?? id)),
        aliases: current.modelAliases,
      };
    },
    discover: signal => native.refresh(signal),
  });
}
