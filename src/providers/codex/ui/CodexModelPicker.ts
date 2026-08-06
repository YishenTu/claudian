import { Notice } from 'obsidian';

import { ProviderSettingsCoordinator } from '../../../core/providers/ProviderSettingsCoordinator';
import type { ProviderSettingsTabRendererContext } from '../../../core/providers/types';
import {
  type ProviderModelPickerController,
  type ProviderModelPickerModel,
  type ProviderModelPickerState,
  renderProviderModelPicker,
} from '../../../shared/settings/ProviderModelPicker';
import type { CodexWorkspaceServices } from '../app/CodexWorkspaceServices';
import {
  getCodexModelsInPickerOrder,
  isCodexModelAvailable,
} from '../models';
import {
  createCodexVisibleModelFilter,
  getCodexProviderSettings,
  getVisibleCodexModelIds,
  updateCodexProviderSettings,
} from '../settings';

function sameVisibleModels(left: string[] | null, right: string[] | null): boolean {
  if (left === null || right === null) {
    return left === right;
  }
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export function renderCodexModelPicker(
  container: HTMLElement,
  context: ProviderSettingsTabRendererContext,
  workspace: CodexWorkspaceServices,
): ProviderModelPickerController {
  const settingsBag = context.plugin.settings as unknown as Record<string, unknown>;

  const getState = (): ProviderModelPickerState => {
    const current = getCodexProviderSettings(settingsBag);
    const pickerOrderedModels = getCodexModelsInPickerOrder(current.discoveredModels);
    const visibleModelIds = getVisibleCodexModelIds(
      current.visibleModels,
      current.discoveredModels,
    );
    const selectedIds = visibleModelIds;
    const defaultModelId = selectedIds.find((modelId) => {
      const model = current.discoveredModels.find(candidate => candidate.model === modelId);
      return Boolean(model && isCodexModelAvailable(model, current.enableUltraEffort));
    }) ?? null;

    const models: ProviderModelPickerModel[] = pickerOrderedModels.map((model) => {
      const isAvailable = isCodexModelAvailable(model, current.enableUltraEffort);
      return {
        ...(model.isDefault ? { catalogBadge: 'Default' } : {}),
        description: model.description,
        id: model.model,
        isAvailable,
        name: model.displayName,
        ...(!isAvailable
          ? {
            unavailableMessage: 'Requires Ultra effort to be enabled',
            unavailableTitle: 'This model only supports Ultra effort',
          }
          : {}),
      };
    });
    const discoveredIds = new Set(models.map(model => model.id));
    for (const modelId of visibleModelIds) {
      if (!discoveredIds.has(modelId)) {
        models.push({
          description: 'Selected model',
          id: modelId,
          isAvailable: false,
          name: modelId,
          unavailableMessage: 'Not currently reported by Codex',
        });
      }
    }

    return {
      aliases: current.modelAliases,
      defaultModelId,
      discoveredCount: current.discoveredModels.length,
      models,
      selectedIds,
    };
  };

  const persistVisibleModels = async (modelIds: string[]): Promise<void> => {
    const current = getCodexProviderSettings(settingsBag);
    const nextVisibleModels = createCodexVisibleModelFilter(modelIds, current.discoveredModels);
    if (sameVisibleModels(current.visibleModels, nextVisibleModels)) {
      return;
    }

    await context.plugin.mutateSettings((settings) => {
      updateCodexProviderSettings(settings, { visibleModels: nextVisibleModels });
      ProviderSettingsCoordinator.normalizeAllModelVariants(settings);
    });
    context.notifyProviderModelOptionsChanged('codex');
  };

  let refreshPicker = (): void => {};
  const picker = renderProviderModelPicker({
    checkCatalogFreshnessWhenCached: true,
    container,
    emptyCatalogText: 'No Codex models discovered yet. Click Discover to query app-server.',
    failedCatalogText: 'Could not load models from Codex app-server. Check the CLI path and login state, then try again.',
    getState,
    initiallyOpen: getCodexProviderSettings(settingsBag).discoveredModels.length === 0,
    async loadCatalog(force) {
      if (!workspace.modelCatalogCoordinator) {
        return 'failed';
      }

      const result = await workspace.modelCatalogCoordinator.ensureFresh('model-picker', { force });
      if (result.backgroundRefresh) {
        void result.backgroundRefresh.then(
          (backgroundResult) => {
            refreshPicker();
            if (backgroundResult.refreshed) {
              context.notifyProviderModelOptionsChanged('codex');
            }
          },
          () => refreshPicker(),
        );
      }
      if (result.diagnostics) {
        new Notice(`Codex model discovery failed: ${result.diagnostics}`);
        return 'failed';
      }
      if (result.refreshed) {
        context.notifyProviderModelOptionsChanged('codex');
      }
      return getCodexProviderSettings(settingsBag).discoveredModels.length > 0 ? 'loaded' : 'empty';
    },
    loadingCatalogText: 'Loading the Codex model catalog...',
    modifier: 'codex',
    async onAliasesChange(modelAliases) {
      await context.plugin.mutateSettings((settings) => {
        updateCodexProviderSettings(settings, { modelAliases });
      });
      context.notifyProviderModelOptionsChanged('codex');
    },
    onSelectedIdsChange: persistVisibleModels,
    providerName: 'Codex',
    searchPlaceholder: 'Filter by model name, description, or ID...',
  });
  refreshPicker = picker.refresh.bind(picker);
  return picker;
}
