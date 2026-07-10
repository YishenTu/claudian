import { Notice, Setting } from 'obsidian';

import { ProviderSettingsCoordinator } from '../../../core/providers/ProviderSettingsCoordinator';
import type { ProviderSettingsTabRendererContext } from '../../../core/providers/types';
import type { CodexWorkspaceServices } from '../app/CodexWorkspaceServices';
import { type CodexDiscoveredModel, getCodexModelsInPickerOrder } from '../models';
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

function matchesSearch(model: CodexDiscoveredModel, query: string): boolean {
  if (!query) {
    return true;
  }

  return model.model.toLowerCase().includes(query)
    || model.displayName.toLowerCase().includes(query)
    || model.description.toLowerCase().includes(query);
}

export function renderCodexModelPicker(
  container: HTMLElement,
  context: ProviderSettingsTabRendererContext,
  workspace: CodexWorkspaceServices,
): void {
  const settingsBag = context.plugin.settings as unknown as Record<string, unknown>;

  new Setting(container)
    .setName('Visible models')
    .setDesc('Choose which app-server models appear in the Codex selector. Existing session models stay pinned even when hidden here.');

  const pickerEl = container.createDiv({
    cls: 'claudian-provider-model-picker claudian-provider-model-picker--codex',
  });
  let searchQuery = '';
  let loading = false;
  let loadFailed = false;

  const summaryEl = pickerEl.createDiv({ cls: 'claudian-provider-model-picker-summary' });
  const selectedEl = pickerEl.createDiv({ cls: 'claudian-provider-model-picker-selected' });
  const catalogEl = pickerEl.createEl('details', { cls: 'claudian-provider-model-picker-catalog' });
  catalogEl.open = getCodexProviderSettings(settingsBag).discoveredModels.length === 0;

  const catalogSummaryEl = catalogEl.createEl('summary', {
    cls: 'claudian-provider-model-picker-catalog-summary',
  });
  catalogSummaryEl.createSpan({
    cls: 'claudian-provider-model-picker-catalog-caret',
    text: '▸',
  });
  catalogSummaryEl.createSpan({
    cls: 'claudian-provider-model-picker-catalog-title',
    text: 'Browse models',
  });
  const catalogSummaryCountEl = catalogSummaryEl.createSpan({
    cls: 'claudian-provider-model-picker-catalog-count',
  });

  const controlsEl = catalogEl.createDiv({ cls: 'claudian-provider-model-picker-controls' });
  const searchInput = controlsEl.createEl('input', {
    cls: 'claudian-provider-model-picker-search',
    type: 'search',
  });
  searchInput.placeholder = 'Filter by model name, description, or ID...';
  searchInput.addEventListener('input', () => {
    searchQuery = searchInput.value.trim().toLowerCase();
    renderList();
  });

  const refreshButtonEl = controlsEl.createEl('button', {
    cls: 'claudian-provider-model-picker-action',
    text: 'Refresh',
  });
  refreshButtonEl.setAttribute('type', 'button');
  refreshButtonEl.addEventListener('click', () => {
    void refreshCatalog();
  });

  const listEl = catalogEl.createDiv({ cls: 'claudian-provider-model-picker-list' });

  const getVisibleModelIds = (): string[] => {
    const current = getCodexProviderSettings(settingsBag);
    return getVisibleCodexModelIds(current.visibleModels, current.discoveredModels);
  };

  const persistVisibleModels = async (modelIds: string[]): Promise<void> => {
    const current = getCodexProviderSettings(settingsBag);
    const nextVisibleModels = createCodexVisibleModelFilter(modelIds, current.discoveredModels);
    if (sameVisibleModels(current.visibleModels, nextVisibleModels)) {
      return;
    }

    updateCodexProviderSettings(settingsBag, { visibleModels: nextVisibleModels });
    ProviderSettingsCoordinator.normalizeAllModelVariants(settingsBag);
    await context.plugin.saveSettings();
    renderAll();
    context.refreshModelSelectors();
  };

  const renderSummary = (): void => {
    summaryEl.empty();
    const current = getCodexProviderSettings(settingsBag);
    const visibleCount = getVisibleCodexModelIds(
      current.visibleModels,
      current.discoveredModels,
    ).length;

    summaryEl.createSpan({ text: 'Visible: ' });
    summaryEl.createSpan({
      cls: 'claudian-provider-model-picker-summary-value',
      text: String(visibleCount),
    });
    summaryEl.createSpan({ text: ` of ${current.discoveredModels.length} discovered` });

    let catalogSummary = 'No models discovered yet';
    if (loading) {
      catalogSummary = 'Loading models...';
    } else if (current.discoveredModels.length > 0) {
      catalogSummary = `${current.discoveredModels.length} available`;
    }
    catalogSummaryCountEl.setText(catalogSummary);
    refreshButtonEl.disabled = loading;
    refreshButtonEl.setText(loading ? 'Loading...' : 'Refresh');
  };

  const renderSelected = (): void => {
    selectedEl.empty();
    const current = getCodexProviderSettings(settingsBag);
    const visibleModelIds = getVisibleModelIds();
    if (visibleModelIds.length === 0) {
      selectedEl.toggleClass('claudian-hidden', true);
      return;
    }

    selectedEl.toggleClass('claudian-hidden', false);
    const modelsById = new Map(current.discoveredModels.map(model => [model.model, model]));
    const visibleModelIdSet = new Set(visibleModelIds);
    const pickerOrderedVisibleModelIds = getCodexModelsInPickerOrder(current.discoveredModels)
      .map(model => model.model)
      .filter(modelId => visibleModelIdSet.has(modelId));
    for (const modelId of visibleModelIds) {
      if (!modelsById.has(modelId)) {
        pickerOrderedVisibleModelIds.push(modelId);
      }
    }
    const headerEl = selectedEl.createDiv({ cls: 'claudian-provider-model-picker-selected-header' });
    headerEl.createEl('span', {
      cls: 'claudian-provider-model-picker-selected-label',
      text: `Selected (${visibleModelIds.length})`,
    });
    const clearAllButton = headerEl.createEl('button', {
      cls: 'claudian-provider-model-picker-selected-clear',
      text: 'Clear all',
    });
    clearAllButton.setAttribute('type', 'button');
    clearAllButton.setAttribute('aria-label', 'Clear all selected Codex models');
    clearAllButton.addEventListener('click', () => {
      void persistVisibleModels([]);
    });

    const rowsEl = selectedEl.createDiv({ cls: 'claudian-provider-model-picker-selected-rows' });
    for (const modelId of pickerOrderedVisibleModelIds) {
      const model = modelsById.get(modelId);
      const rowEl = rowsEl.createDiv({ cls: 'claudian-provider-model-picker-selected-row' });
      const infoEl = rowEl.createDiv({ cls: 'claudian-provider-model-picker-selected-info' });
      const titleEl = infoEl.createDiv({ cls: 'claudian-provider-model-picker-selected-title' });
      titleEl.createEl('span', {
        cls: 'claudian-provider-model-picker-selected-name',
        text: model?.displayName ?? modelId,
      });
      infoEl.createEl('div', {
        cls: 'claudian-provider-model-picker-selected-id',
        text: modelId,
      });

      const controls = rowEl.createDiv({ cls: 'claudian-provider-model-picker-selected-controls' });
      const removeButton = controls.createEl('button', {
        cls: 'claudian-provider-model-picker-selected-remove',
        text: '×',
      });
      removeButton.setAttribute('type', 'button');
      removeButton.setAttribute('aria-label', `Remove ${model?.displayName ?? modelId}`);
      removeButton.addEventListener('click', () => {
        void persistVisibleModels(getVisibleModelIds().filter(id => id !== modelId));
      });
    }
  };

  const renderList = (): void => {
    listEl.empty();
    const current = getCodexProviderSettings(settingsBag);
    const selectedIds = new Set(getVisibleModelIds());
    const models = getCodexModelsInPickerOrder(current.discoveredModels)
      .filter(model => matchesSearch(model, searchQuery));

    if (models.length === 0) {
      let message = 'No models match your filter.';
      if (loading) {
        message = 'Loading the Codex model catalog...';
      } else if (loadFailed) {
        message = 'Could not load models from Codex app-server. Check the CLI path and login state, then try again.';
      } else if (current.discoveredModels.length === 0) {
        message = 'No Codex models discovered yet. Click Refresh to query app-server.';
      }
      listEl.createDiv({ cls: 'claudian-provider-model-picker-empty', text: message });
      return;
    }

    for (const model of models) {
      const rowEl = listEl.createEl('label', { cls: 'claudian-provider-model-picker-row' });
      const isSelected = selectedIds.has(model.model);
      if (isSelected) {
        rowEl.classList.add('claudian-provider-model-picker-row--selected');
      }
      rowEl.title = model.model;

      const checkboxEl = rowEl.createEl('input', { type: 'checkbox' });
      checkboxEl.checked = isSelected;
      checkboxEl.addEventListener('change', () => {
        const latest = getCodexProviderSettings(settingsBag);
        const latestSelectedIds = new Set(getVisibleCodexModelIds(
          latest.visibleModels,
          latest.discoveredModels,
        ));
        if (checkboxEl.checked) {
          latestSelectedIds.add(model.model);
        } else {
          latestSelectedIds.delete(model.model);
        }
        const nextModelIds = latest.discoveredModels
          .map(candidate => candidate.model)
          .filter(modelId => latestSelectedIds.has(modelId));
        void persistVisibleModels(nextModelIds);
      });

      const textEl = rowEl.createDiv({ cls: 'claudian-provider-model-picker-row-text' });
      const headerEl = textEl.createDiv({ cls: 'claudian-provider-model-picker-row-header' });
      headerEl.createEl('span', {
        cls: 'claudian-provider-model-picker-row-name',
        text: model.displayName,
      });
      if (model.isDefault) {
        headerEl.createEl('span', {
          cls: 'claudian-provider-model-picker-row-badge',
          text: 'Default',
        });
      }
      textEl.createDiv({
        cls: 'claudian-provider-model-picker-row-meta',
        text: model.model,
      });
      if (model.description) {
        textEl.createDiv({
          cls: 'claudian-provider-model-picker-row-desc',
          text: model.description,
        });
      }
    }
  };

  const renderAll = (): void => {
    renderSummary();
    renderSelected();
    renderList();
  };

  const refreshCatalog = async (): Promise<void> => {
    if (loading || !workspace.refreshModelCatalog) {
      return;
    }

    loading = true;
    loadFailed = false;
    renderAll();
    try {
      const result = await workspace.refreshModelCatalog();
      if (result.diagnostics) {
        loadFailed = true;
        new Notice(`Codex model discovery failed: ${result.diagnostics}`);
        return;
      }
      if (result.persistedSettingsChanged) {
        await context.plugin.saveSettings();
      }
      context.refreshModelSelectors();
    } finally {
      loading = false;
      renderAll();
    }
  };

  renderAll();
  catalogEl.addEventListener('toggle', () => {
    if (catalogEl.open && getCodexProviderSettings(settingsBag).discoveredModels.length === 0) {
      void refreshCatalog();
    }
  });
}
