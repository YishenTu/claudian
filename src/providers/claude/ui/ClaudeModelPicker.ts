import type { ProviderSettingsTabRendererContext } from '../../../core/providers/types';
import { renderProviderModelPicker } from '../../../shared/settings/ProviderModelPicker';
import { findClaudeModelOption, getClaudeModelCatalog, getClaudeModelOptions, getClaudeVisibleModelIds } from '../modelOptions';
import { toClaudeRuntimeModelId } from '../modelSelection';
import type { ClaudeModelCatalog } from '../runtime/ClaudeModelCatalog';
import { updateClaudeProviderSettings } from '../settings';

export function renderClaudeModelPicker(container: HTMLElement, context: ProviderSettingsTabRendererContext, catalog: Pick<ClaudeModelCatalog, 'refresh'>) {
  return renderProviderModelPicker({
    container,
    loadCatalogOnRender: true,
    providerName: 'Claude',
    modifier: 'claude',
    emptyCatalogText: 'No models reported by Claude Code. Configure your model in environment variables or Claude settings, then refresh this list.',
    failedCatalogText: 'Couldn’t load Claude models. Check your configuration and refresh the model list.',
    loadingCatalogText: 'Loading Claude models…',
    async loadCatalog() {
      const result = await catalog.refresh();
      return result.diagnostics?.length ? 'failed' : 'loaded';
    },
    getState() {
      const settings = context.plugin.settings;
      const models = getClaudeModelCatalog(settings);
      const defaultModel = getClaudeModelOptions(settings)[0]?.value;
      return {
        aliases: (settings.customModelAliases ?? {}),
        discoveredCount: models.length,
        selectedIds: [...new Set(getClaudeVisibleModelIds(settings).map(id =>
          toClaudeRuntimeModelId(findClaudeModelOption(models, id)?.value ?? id)
        ))],
        defaultModelId: defaultModel ? toClaudeRuntimeModelId(defaultModel) : null,
        models: models.map(model => ({
          id: toClaudeRuntimeModelId(model.value), name: model.label, description: model.description,
        })),
      };
    },
    async onSelectedIdsChange(visibleModels) {
      await context.plugin.mutateSettings(settings => { updateClaudeProviderSettings(settings, { visibleModels }); });
      context.notifyProviderModelOptionsChanged('claude');
    },
    async onAliasesChange(aliases) {
      await context.plugin.mutateSettings(settings => { settings.customModelAliases = aliases; });
      context.notifyProviderModelOptionsChanged('claude');
    },
  });
}
