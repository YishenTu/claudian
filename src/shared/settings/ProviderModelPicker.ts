import { Setting } from 'obsidian';

const ALL_PROVIDERS_KEY = 'all';

export interface ProviderModelPickerModel {
  aliasPlaceholder?: string;
  catalogBadge?: string;
  description?: string;
  id: string;
  isAvailable?: boolean;
  name: string;
  providerKey?: string;
  providerLabel?: string;
  unavailableMessage?: string;
  unavailableTitle?: string;
}

export interface ProviderModelPickerState {
  aliases: Record<string, string>;
  discoveredCount: number;
  models: ProviderModelPickerModel[];
  selectedIds: string[];
}

export interface ProviderModelPickerController {
  refresh(): void;
}

export interface ProviderModelPickerOptions {
  checkCatalogFreshnessWhenCached?: boolean;
  container: HTMLElement;
  emptyCatalogText: string;
  failedCatalogText: string;
  getState(): ProviderModelPickerState;
  initiallyOpen?: boolean;
  loadCatalog(force: boolean): Promise<'empty' | 'failed' | 'loaded'>;
  loadCatalogOnRender?: boolean;
  loadingCatalogText: string;
  modifier: string;
  onAliasesChange(aliases: Record<string, string>): Promise<void>;
  onModelSelected?(model: ProviderModelPickerModel): Promise<void>;
  onSelectedIdsChange(selectedIds: string[]): Promise<void>;
  providerName: string;
  searchPlaceholder?: string;
  settingDescription: string;
}

export function renderProviderModelPicker(
  options: ProviderModelPickerOptions,
): ProviderModelPickerController {
  new Setting(options.container)
    .setName('Visible models')
    .setDesc(options.settingDescription);

  const pickerEl = options.container.createDiv({
    cls: `claudian-provider-model-picker claudian-provider-model-picker--${options.modifier}`,
  });
  let searchQuery = '';
  let providerFilter = ALL_PROVIDERS_KEY;
  let loadingCatalog = false;
  let catalogLoadFailed = false;

  const summaryEl = pickerEl.createDiv({ cls: 'claudian-provider-model-picker-summary' });
  const selectedEl = pickerEl.createDiv({ cls: 'claudian-provider-model-picker-selected' });
  const catalogEl = pickerEl.createEl('details', { cls: 'claudian-provider-model-picker-catalog' });
  catalogEl.open = options.initiallyOpen ?? options.getState().selectedIds.length === 0;

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
  searchInput.placeholder = options.searchPlaceholder ?? 'Filter by model, provider, or ID...';
  searchInput.addEventListener('input', () => {
    searchQuery = searchInput.value.trim().toLowerCase();
    renderList();
  });

  const providerSelectEl = controlsEl.createEl('select', {
    cls: 'claudian-provider-model-picker-provider',
  });
  providerSelectEl.addEventListener('change', () => {
    providerFilter = providerSelectEl.value;
    renderList();
  });

  const catalogActionEl = controlsEl.createEl('button', {
    cls: 'claudian-provider-model-picker-action',
    text: 'Discover',
  });
  catalogActionEl.setAttribute('type', 'button');
  catalogActionEl.addEventListener('click', () => {
    void loadCatalog(true);
  });

  const listEl = catalogEl.createDiv({ cls: 'claudian-provider-model-picker-list' });

  const renderSummary = (): void => {
    summaryEl.empty();
    const state = options.getState();
    const providerCount = new Set(
      state.models.map(model => model.providerKey).filter((key): key is string => Boolean(key)),
    ).size;

    summaryEl.createSpan({ text: 'Visible: ' });
    summaryEl.createSpan({
      cls: 'claudian-provider-model-picker-summary-value',
      text: String(state.selectedIds.length),
    });
    summaryEl.createSpan({
      text: providerCount > 0
        ? ` of ${state.discoveredCount} discovered | ${providerCount} ${providerCount === 1 ? 'provider' : 'providers'}`
        : ` of ${state.discoveredCount} discovered`,
    });

    catalogSummaryCountEl.setText(
      loadingCatalog
        ? 'Loading models...'
        : state.discoveredCount > 0
        ? `${state.discoveredCount} available`
        : 'No models discovered yet',
    );
    catalogActionEl.disabled = loadingCatalog;
    catalogActionEl.setText(
      loadingCatalog
        ? 'Loading...'
        : state.discoveredCount > 0
        ? 'Refresh'
        : 'Discover',
    );
  };

  const persistAlias = async (modelId: string, value: string): Promise<void> => {
    const state = options.getState();
    const existing = state.aliases[modelId] ?? '';
    const next = value.trim();
    if (next === existing) {
      return;
    }

    const aliases = { ...state.aliases };
    if (next) {
      aliases[modelId] = next;
    } else {
      delete aliases[modelId];
    }
    await options.onAliasesChange(aliases);
    renderSelected();
  };

  const renderSelected = (): void => {
    selectedEl.empty();
    const state = options.getState();
    if (state.selectedIds.length === 0) {
      selectedEl.toggleClass('claudian-hidden', true);
      return;
    }

    selectedEl.toggleClass('claudian-hidden', false);
    const modelsById = new Map(state.models.map(model => [model.id, model] as const));
    const headerEl = selectedEl.createDiv({ cls: 'claudian-provider-model-picker-selected-header' });
    headerEl.createSpan({
      cls: 'claudian-provider-model-picker-selected-label',
      text: `Selected (${state.selectedIds.length})`,
    });
    const clearAllButton = headerEl.createEl('button', {
      cls: 'claudian-provider-model-picker-selected-clear',
      text: 'Clear all',
    });
    clearAllButton.setAttribute('type', 'button');
    clearAllButton.setAttribute('aria-label', `Clear all selected ${options.providerName} models`);
    clearAllButton.addEventListener('click', () => {
      void persistSelectedIds([]);
    });

    const rowsEl = selectedEl.createDiv({ cls: 'claudian-provider-model-picker-selected-rows' });
    for (const modelId of state.selectedIds) {
      const model = modelsById.get(modelId) ?? {
        id: modelId,
        isAvailable: false,
        name: modelId,
      };
      const defaultLabel = model.aliasPlaceholder
        ?? (model.providerLabel ? `${model.providerLabel}/${model.name}` : model.name);
      const rowEl = rowsEl.createDiv({ cls: 'claudian-provider-model-picker-selected-row' });
      if (model.isAvailable === false) {
        rowEl.classList.add('claudian-provider-model-picker-selected-row--unavailable');
      }

      const infoEl = rowEl.createDiv({ cls: 'claudian-provider-model-picker-selected-info' });
      const titleEl = infoEl.createDiv({ cls: 'claudian-provider-model-picker-selected-title' });
      if (model.providerLabel) {
        titleEl.createSpan({
          cls: 'claudian-provider-model-picker-selected-badge',
          text: model.providerLabel,
        });
      }
      titleEl.createSpan({
        cls: 'claudian-provider-model-picker-selected-name',
        text: model.name,
      });
      if (model.isAvailable === false && model.unavailableMessage) {
        infoEl.createDiv({
          cls: 'claudian-provider-model-picker-selected-unavailable',
          text: model.unavailableMessage,
        });
      }
      infoEl.createDiv({
        cls: 'claudian-provider-model-picker-selected-id',
        text: model.id,
      });

      const rowControlsEl = rowEl.createDiv({ cls: 'claudian-provider-model-picker-selected-controls' });
      const aliasInput = rowControlsEl.createEl('input', {
        cls: 'claudian-provider-model-picker-selected-alias',
        type: 'text',
      });
      aliasInput.placeholder = defaultLabel;
      aliasInput.value = state.aliases[model.id] ?? '';
      aliasInput.setAttribute('aria-label', `Alias for ${defaultLabel}`);
      aliasInput.title = 'Custom label shown in the model selector. Leave empty to use the default.';
      aliasInput.addEventListener('blur', () => {
        void persistAlias(model.id, aliasInput.value);
      });
      aliasInput.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          aliasInput.blur();
        } else if (event.key === 'Escape') {
          event.preventDefault();
          aliasInput.value = options.getState().aliases[model.id] ?? '';
          aliasInput.blur();
        }
      });

      const removeButton = rowControlsEl.createEl('button', {
        cls: 'claudian-provider-model-picker-selected-remove',
        text: '×',
      });
      removeButton.setAttribute('type', 'button');
      removeButton.setAttribute('aria-label', `Remove ${defaultLabel}`);
      removeButton.addEventListener('click', () => {
        void persistSelectedIds(options.getState().selectedIds.filter(id => id !== model.id));
      });
    }
  };

  const renderProviderSelect = (): void => {
    const providers = new Map<string, { count: number; label: string }>();
    const models = options.getState().models;
    for (const model of models) {
      if (!model.providerKey || !model.providerLabel) {
        continue;
      }
      const existing = providers.get(model.providerKey);
      if (existing) {
        existing.count += 1;
      } else {
        providers.set(model.providerKey, { count: 1, label: model.providerLabel });
      }
    }

    providerSelectEl.toggleClass('claudian-hidden', providers.size === 0);
    providerSelectEl.empty();
    providerSelectEl.createEl('option', {
      text: `All providers (${models.length})`,
      value: ALL_PROVIDERS_KEY,
    });
    for (const [key, { count, label }] of Array.from(providers.entries())
      .sort(([, left], [, right]) => left.label.localeCompare(right.label))) {
      providerSelectEl.createEl('option', {
        text: `${label} (${count})`,
        value: key,
      });
    }

    if (providerFilter !== ALL_PROVIDERS_KEY && !providers.has(providerFilter)) {
      providerFilter = ALL_PROVIDERS_KEY;
    }
    providerSelectEl.value = providerFilter;
  };

  const matchesFilter = (model: ProviderModelPickerModel): boolean => {
    if (providerFilter !== ALL_PROVIDERS_KEY && model.providerKey !== providerFilter) {
      return false;
    }
    if (!searchQuery) {
      return true;
    }

    return [model.id, model.name, model.providerLabel ?? '', model.description ?? '']
      .some(value => value.toLowerCase().includes(searchQuery));
  };

  const persistSelectedIds = async (selectedIds: string[]): Promise<void> => {
    await options.onSelectedIdsChange(selectedIds);
    renderAll();
  };

  const renderList = (): void => {
    listEl.empty();
    const state = options.getState();
    const selectedIds = new Set(state.selectedIds);
    const models = state.models.filter(matchesFilter);

    if (models.length === 0) {
      listEl.createDiv({
        cls: 'claudian-provider-model-picker-empty',
        text: loadingCatalog
          ? options.loadingCatalogText
          : catalogLoadFailed
          ? options.failedCatalogText
          : state.models.length === 0
          ? options.emptyCatalogText
          : 'No models match your filter.',
      });
      return;
    }

    for (const model of models) {
      const rowEl = listEl.createEl('label', { cls: 'claudian-provider-model-picker-row' });
      const isSelected = selectedIds.has(model.id);
      if (isSelected) {
        rowEl.classList.add('claudian-provider-model-picker-row--selected');
      }
      rowEl.title = model.id;

      const checkboxEl = rowEl.createEl('input', { type: 'checkbox' });
      checkboxEl.checked = isSelected;
      const persistSelection = async (): Promise<void> => {
        const selecting = checkboxEl.checked;
        const currentIds = options.getState().selectedIds;
        const nextIds = selecting
          ? [...currentIds, model.id]
          : currentIds.filter(id => id !== model.id);
        await persistSelectedIds(nextIds);
        if (selecting) {
          await options.onModelSelected?.(model);
        }
      };
      checkboxEl.addEventListener('change', () => {
        void persistSelection();
      });

      const textEl = rowEl.createDiv({ cls: 'claudian-provider-model-picker-row-text' });
      const headerEl = textEl.createDiv({ cls: 'claudian-provider-model-picker-row-header' });
      headerEl.createSpan({
        cls: 'claudian-provider-model-picker-row-name',
        text: model.name,
      });
      const badgeLabel = model.isAvailable === false
        ? 'Unavailable'
        : model.catalogBadge ?? model.providerLabel;
      if (badgeLabel) {
        const badgeEl = headerEl.createSpan({
          cls: 'claudian-provider-model-picker-row-badge',
          text: badgeLabel,
        });
        if (model.isAvailable === false) {
          badgeEl.classList.add('claudian-provider-model-picker-row-badge--unavailable');
          badgeEl.title = model.unavailableTitle ?? `Configured model not currently reported by ${options.providerName}`;
        }
      }
      textEl.createDiv({
        cls: 'claudian-provider-model-picker-row-meta',
        text: model.id,
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
    renderProviderSelect();
    renderList();
  };

  const loadCatalog = async (force: boolean): Promise<void> => {
    if (
      loadingCatalog
      || (
        !force
        && !options.checkCatalogFreshnessWhenCached
        && options.getState().discoveredCount > 0
      )
    ) {
      return;
    }

    loadingCatalog = true;
    catalogLoadFailed = false;
    renderAll();
    try {
      catalogLoadFailed = await options.loadCatalog(force) === 'failed';
    } catch {
      catalogLoadFailed = true;
    } finally {
      loadingCatalog = false;
      renderAll();
    }
  };

  renderAll();
  catalogEl.addEventListener('toggle', () => {
    if (catalogEl.open) {
      void loadCatalog(false);
    }
  });
  if (options.loadCatalogOnRender) {
    void loadCatalog(false);
  }
  return { refresh: renderAll };
}
