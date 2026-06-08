import * as fs from 'node:fs';

import { Notice, Setting } from 'obsidian';

import type { ProviderSettingsTabRenderer } from '../../../core/providers/types';
import { renderEnvironmentSettingsSection } from '../../../features/settings/ui/EnvironmentSettingsSection';
import { getHostnameKey } from '../../../utils/env';
import { expandHomePath } from '../../../utils/path';
import { maybeGetPiWorkspaceServices } from '../app/PiWorkspaceServices';
import { sameStringList } from '../internal/compareCollections';
import {
  decodePiModelId,
  type PiDiscoveredModel,
} from '../models';
import { PiModelDiscoveryService } from '../runtime/PiModelDiscoveryService';
import {
  getPiProviderSettings,
  normalizePiVisibleModels,
  updatePiProviderSettings,
} from '../settings';

const ALL_PROVIDERS_KEY = 'all';

interface EnrichedPiModel {
  description: string;
  encodedId: string;
  isAvailable: boolean;
  modelLabel: string;
  providerKey: string;
  providerLabel: string;
}

export const piSettingsTabRenderer: ProviderSettingsTabRenderer = {
  render(container, context) {
    const settingsBag = context.plugin.settings as unknown as Record<string, unknown>;
    const piSettings = getPiProviderSettings(settingsBag);
    const hostnameKey = getHostnameKey();
    const workspace = maybeGetPiWorkspaceServices();

    new Setting(container).setName('Setup').setHeading();

    new Setting(container)
      .setName('Enable Pi')
      .setDesc('Launch `pi --mode rpc` as a provider.')
      .addToggle((toggle) =>
        toggle
          .setValue(piSettings.enabled)
          .onChange(async (value) => {
            updatePiProviderSettings(settingsBag, { enabled: value });
            await context.plugin.saveSettings();
            context.refreshModelSelectors();
          })
      );

    const validationEl = container.createDiv({
      cls: 'claudian-cli-path-validation claudian-setting-validation claudian-setting-validation-error claudian-hidden',
    });
    const cliPathsByHost = { ...piSettings.cliPathsByHost };
    let cliPathInputEl: HTMLInputElement | null = null;

    const updateCliPathValidation = (value: string, inputEl?: HTMLInputElement): boolean => {
      const error = validateCliPath(value);
      if (error) {
        validationEl.setText(error);
        validationEl.toggleClass('claudian-hidden', false);
        inputEl?.toggleClass('claudian-input-error', true);
        return false;
      }

      validationEl.toggleClass('claudian-hidden', true);
      inputEl?.toggleClass('claudian-input-error', false);
      return true;
    };

    const persistCliPath = async (value: string): Promise<void> => {
      if (!updateCliPathValidation(value, cliPathInputEl ?? undefined)) {
        return;
      }

      const trimmed = value.trim();
      if (trimmed) {
        cliPathsByHost[hostnameKey] = trimmed;
      } else {
        delete cliPathsByHost[hostnameKey];
      }

      updatePiProviderSettings(settingsBag, {
        cliPathsByHost: { ...cliPathsByHost },
        discoveredModels: [],
      });
      workspace?.cliResolver?.reset();
      await context.plugin.saveSettings();
      context.refreshModelSelectors();
    };

    new Setting(container)
      .setName('CLI path')
      .setDesc('Optional absolute path to the Pi CLI for this computer. Leave empty to use `pi` from PATH.')
      .addText((text) => {
        const currentValue = piSettings.cliPathsByHost[hostnameKey] || '';
        text
          .setPlaceholder(process.platform === 'win32'
            ? 'C:\\Users\\you\\AppData\\Roaming\\npm\\pi.cmd'
            : '/usr/local/bin/pi')
          .setValue(currentValue)
          .onChange((value) => {
            void persistCliPath(value);
          });
        cliPathInputEl = text.inputEl;
        updateCliPathValidation(currentValue, text.inputEl);
      });

    new Setting(container).setName('Models').setHeading();

    new Setting(container)
      .setName('Visible models')
      .setDesc('Choose which Pi models appear in the chat selector. Filter by provider or type to search. The current session model stays pinned even if it is not selected here.');

    const pickerEl = container.createDiv({ cls: 'claudian-provider-model-picker claudian-provider-model-picker--pi' });

    let searchQuery = '';
    let providerFilter = ALL_PROVIDERS_KEY;
    let loadingModelCatalog = false;
    let modelCatalogLoadFailed = false;

    const summaryEl = pickerEl.createDiv({ cls: 'claudian-provider-model-picker-summary' });
    const selectedEl = pickerEl.createDiv({ cls: 'claudian-provider-model-picker-selected' });
    const catalogEl = pickerEl.createEl('details', { cls: 'claudian-provider-model-picker-catalog' });
    catalogEl.open = getPiProviderSettings(settingsBag).visibleModels.length === 0;

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
    searchInput.placeholder = 'Filter by model, provider, or ID...';
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

    const discoverButtonEl = controlsEl.createEl('button', {
      cls: 'claudian-provider-model-picker-action',
      text: 'Discover',
    });
    discoverButtonEl.setAttribute('type', 'button');
    discoverButtonEl.addEventListener('click', () => {
      void loadModelCatalog({ force: true });
    });

    const listEl = catalogEl.createDiv({ cls: 'claudian-provider-model-picker-list' });

    const getEnrichedModels = (): EnrichedPiModel[] => {
      const current = getPiProviderSettings(settingsBag);
      return buildEnrichedPiModels(current.discoveredModels, current.visibleModels);
    };

    const filterModels = (models: EnrichedPiModel[]): EnrichedPiModel[] => {
      return models.filter((model) => {
        if (providerFilter !== ALL_PROVIDERS_KEY && model.providerKey !== providerFilter) {
          return false;
        }

        if (!searchQuery) {
          return true;
        }

        return (
          model.encodedId.toLowerCase().includes(searchQuery)
          || model.modelLabel.toLowerCase().includes(searchQuery)
          || model.providerLabel.toLowerCase().includes(searchQuery)
          || model.description.toLowerCase().includes(searchQuery)
        );
      });
    };

    const persistVisibleModels = async (visibleModels: string[]): Promise<void> => {
      const current = getPiProviderSettings(settingsBag);
      const normalized = normalizePiVisibleModels(visibleModels, current.discoveredModels);
      if (sameStringList(current.visibleModels, normalized)) {
        return;
      }

      updatePiProviderSettings(settingsBag, { visibleModels: normalized });
      await context.plugin.saveSettings();
      renderAll();
      context.refreshModelSelectors();
    };

    const persistModelAliases = async (modelAliases: Record<string, string>): Promise<void> => {
      updatePiProviderSettings(settingsBag, { modelAliases });
      await context.plugin.saveSettings();
      renderSelected();
      context.refreshModelSelectors();
    };

    const renderSummary = (): void => {
      summaryEl.empty();
      const current = getPiProviderSettings(settingsBag);
      const enriched = getEnrichedModels();
      const providerCount = new Set(enriched.map((model) => model.providerKey)).size;
      const providerWord = providerCount === 1 ? 'provider' : 'providers';

      summaryEl.createSpan({ text: 'Visible: ' });
      summaryEl.createSpan({
        cls: 'claudian-provider-model-picker-summary-value',
        text: String(current.visibleModels.length),
      });
      summaryEl.createSpan({
        text: ` of ${current.discoveredModels.length} discovered | ${providerCount} ${providerWord}`,
      });

      let catalogSummary = 'No models discovered yet';
      if (loadingModelCatalog) {
        catalogSummary = 'Loading models...';
      } else if (current.discoveredModels.length > 0) {
        catalogSummary = `${current.discoveredModels.length} available`;
      }
      catalogSummaryCountEl.setText(catalogSummary);
      discoverButtonEl.disabled = loadingModelCatalog;
      discoverButtonEl.setText(loadingModelCatalog
        ? 'Loading...'
        : current.discoveredModels.length > 0
        ? 'Refresh'
        : 'Discover');
    };

    const renderSelected = (): void => {
      selectedEl.empty();
      const current = getPiProviderSettings(settingsBag);
      if (current.visibleModels.length === 0) {
        selectedEl.toggleClass('claudian-hidden', true);
        return;
      }

      selectedEl.toggleClass('claudian-hidden', false);
      const enrichedById = new Map(
        getEnrichedModels().map((model) => [model.encodedId, model] as const),
      );

      const headerEl = selectedEl.createDiv({ cls: 'claudian-provider-model-picker-selected-header' });
      headerEl.createEl('span', {
        cls: 'claudian-provider-model-picker-selected-label',
        text: `Selected (${current.visibleModels.length})`,
      });
      const clearAllBtn = headerEl.createEl('button', {
        cls: 'claudian-provider-model-picker-selected-clear',
        text: 'Clear all',
      });
      clearAllBtn.setAttribute('aria-label', 'Clear all selected Pi models');
      clearAllBtn.addEventListener('click', () => {
        void persistVisibleModels([]);
      });

      const rowsEl = selectedEl.createDiv({ cls: 'claudian-provider-model-picker-selected-rows' });

      for (const encodedId of current.visibleModels) {
        const enriched = enrichedById.get(encodedId);
        const defaultLabel = enriched
          ? `${enriched.providerLabel}/${enriched.modelLabel}`
          : encodedId;

        const rowEl = rowsEl.createDiv({ cls: 'claudian-provider-model-picker-selected-row' });
        if (enriched && !enriched.isAvailable) {
          rowEl.classList.add('claudian-provider-model-picker-selected-row--unavailable');
        }

        const infoEl = rowEl.createDiv({ cls: 'claudian-provider-model-picker-selected-info' });
        const titleEl = infoEl.createDiv({ cls: 'claudian-provider-model-picker-selected-title' });
        if (enriched) {
          titleEl.createEl('span', {
            cls: 'claudian-provider-model-picker-selected-badge',
            text: enriched.providerLabel,
          });
          titleEl.createEl('span', {
            cls: 'claudian-provider-model-picker-selected-name',
            text: enriched.modelLabel,
          });
        } else {
          titleEl.createEl('span', {
            cls: 'claudian-provider-model-picker-selected-name',
            text: encodedId,
          });
        }

        if (enriched && !enriched.isAvailable) {
          infoEl.createEl('div', {
            cls: 'claudian-provider-model-picker-selected-unavailable',
            text: 'Not currently reported by Pi',
          });
        }

        infoEl.createEl('div', {
          cls: 'claudian-provider-model-picker-selected-id',
          text: encodedId,
        });

        const rowControlsEl = rowEl.createDiv({ cls: 'claudian-provider-model-picker-selected-controls' });
        const aliasInput = rowControlsEl.createEl('input', {
          cls: 'claudian-provider-model-picker-selected-alias',
          type: 'text',
        });
        aliasInput.placeholder = defaultLabel;
        aliasInput.value = current.modelAliases[encodedId] ?? '';
        aliasInput.setAttribute('aria-label', `Alias for ${defaultLabel}`);
        aliasInput.title = 'Custom label shown in the model selector. Leave empty to use the default.';

        const commitAlias = (): void => {
          const latest = getPiProviderSettings(settingsBag);
          const existing = latest.modelAliases[encodedId] ?? '';
          const next = aliasInput.value.trim();
          if (next === existing) {
            aliasInput.value = existing;
            return;
          }

          const nextAliases = { ...latest.modelAliases };
          if (next) {
            nextAliases[encodedId] = next;
          } else {
            delete nextAliases[encodedId];
          }
          void persistModelAliases(nextAliases);
        };

        aliasInput.addEventListener('blur', commitAlias);
        aliasInput.addEventListener('keydown', (event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            aliasInput.blur();
          } else if (event.key === 'Escape') {
            event.preventDefault();
            aliasInput.value = getPiProviderSettings(settingsBag).modelAliases[encodedId] ?? '';
            aliasInput.blur();
          }
        });

        const removeBtn = rowControlsEl.createEl('button', {
          cls: 'claudian-provider-model-picker-selected-remove',
          text: '×',
        });
        removeBtn.setAttribute('aria-label', `Remove ${defaultLabel}`);
        removeBtn.addEventListener('click', () => {
          void persistVisibleModels(getPiProviderSettings(settingsBag).visibleModels.filter((entry) => entry !== encodedId));
        });
      }
    };

    const renderProviderSelect = (): void => {
      const enriched = getEnrichedModels();
      const providers = new Map<string, { count: number; label: string }>();
      for (const model of enriched) {
        const existing = providers.get(model.providerKey);
        if (existing) {
          existing.count += 1;
        } else {
          providers.set(model.providerKey, { count: 1, label: model.providerLabel });
        }
      }

      providerSelectEl.empty();
      providerSelectEl.createEl('option', {
        text: `All providers (${enriched.length})`,
        value: ALL_PROVIDERS_KEY,
      });

      const sortedProviders = Array.from(providers.entries())
        .sort(([, left], [, right]) => left.label.localeCompare(right.label));
      for (const [key, { count, label }] of sortedProviders) {
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

    const renderList = (): void => {
      listEl.empty();
      const current = getPiProviderSettings(settingsBag);
      const selectedIds = new Set(current.visibleModels);
      const enriched = getEnrichedModels();
      const filtered = filterModels(enriched);

      if (filtered.length === 0) {
        const emptyEl = listEl.createDiv({ cls: 'claudian-provider-model-picker-empty' });
        let emptyText = 'No models match your filter.';
        if (loadingModelCatalog) {
          emptyText = 'Loading Pi model catalog...';
        } else if (modelCatalogLoadFailed) {
          emptyText = 'Could not load the Pi model catalog. Check the CLI path and login state, then try again.';
        } else if (enriched.length === 0) {
          emptyText = 'No Pi models discovered yet. Click Discover to load models from Pi.';
        }
        emptyEl.setText(emptyText);
        return;
      }

      for (const model of filtered) {
        const rowEl = listEl.createEl('label', { cls: 'claudian-provider-model-picker-row' });
        const isSelected = selectedIds.has(model.encodedId);
        if (isSelected) {
          rowEl.classList.add('claudian-provider-model-picker-row--selected');
        }
        rowEl.title = model.encodedId;

        const checkboxEl = rowEl.createEl('input', { type: 'checkbox' });
        checkboxEl.checked = isSelected;
        checkboxEl.addEventListener('change', () => {
          const currentVisibleModels = getPiProviderSettings(settingsBag).visibleModels;
          const next = checkboxEl.checked
            ? [...currentVisibleModels, model.encodedId]
            : currentVisibleModels.filter((id) => id !== model.encodedId);
          void persistVisibleModels(next);
        });

        const textEl = rowEl.createDiv({ cls: 'claudian-provider-model-picker-row-text' });

        const headerEl = textEl.createDiv({ cls: 'claudian-provider-model-picker-row-header' });
        headerEl.createEl('span', {
          cls: 'claudian-provider-model-picker-row-name',
          text: model.modelLabel,
        });
        const badgeEl = headerEl.createEl('span', {
          cls: 'claudian-provider-model-picker-row-badge',
          text: model.providerLabel,
        });
        if (!model.isAvailable) {
          badgeEl.classList.add('claudian-provider-model-picker-row-badge--unavailable');
          badgeEl.setText('Unavailable');
          badgeEl.title = 'Configured model not currently reported by Pi';
        }

        textEl.createDiv({
          cls: 'claudian-provider-model-picker-row-meta',
          text: model.encodedId,
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

    const loadModelCatalog = async ({ force = false }: { force?: boolean } = {}): Promise<void> => {
      if (loadingModelCatalog || (!force && getPiProviderSettings(settingsBag).discoveredModels.length > 0)) {
        return;
      }

      loadingModelCatalog = true;
      modelCatalogLoadFailed = false;
      renderAll();

      try {
        const result = await new PiModelDiscoveryService(context.plugin).discoverModels();
        if (result.diagnostics) {
          modelCatalogLoadFailed = true;
          new Notice(`Pi discovery failed: ${result.diagnostics}`);
          return;
        }

        const current = getPiProviderSettings(settingsBag);
        const normalizedVisibleModels = normalizePiVisibleModels(current.visibleModels, result.models);
        const shouldPersist = result.models.length > 0
          || current.discoveredModels.length > 0
          || !sameStringList(current.visibleModels, normalizedVisibleModels);
        if (shouldPersist) {
          updatePiProviderSettings(settingsBag, {
            discoveredModels: result.models,
            visibleModels: normalizedVisibleModels,
          });
          await context.plugin.saveSettings();
          context.refreshModelSelectors();
        }
      } finally {
        loadingModelCatalog = false;
        renderAll();
      }
    };

    renderAll();

    catalogEl.addEventListener('toggle', () => {
      if (catalogEl.open) {
        void loadModelCatalog();
      }
    });

    renderEnvironmentSettingsSection({
      container,
      desc: 'Environment variables passed only to Pi.',
      heading: 'Environment',
      name: 'Pi environment variables',
      placeholder: 'PI_CODING_AGENT_SESSION_DIR=/path/to/sessions',
      plugin: context.plugin,
      scope: 'provider:pi',
    });
  },
};

function validateCliPath(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  const expandedPath = expandHomePath(trimmed);
  if (!fs.existsSync(expandedPath)) {
    return 'Path does not exist';
  }

  if (!fs.statSync(expandedPath).isFile()) {
    return 'Path must point to a file';
  }

  return null;
}

function buildEnrichedPiModels(
  discoveredModels: PiDiscoveredModel[],
  visibleModels: string[],
): EnrichedPiModel[] {
  const enriched: EnrichedPiModel[] = [];
  const discoveredIds = new Set<string>();

  for (const model of discoveredModels) {
    discoveredIds.add(model.encodedId);
    enriched.push({
      description: buildPiModelDescription(model),
      encodedId: model.encodedId,
      isAvailable: true,
      modelLabel: model.label || model.id,
      providerKey: model.provider.toLowerCase(),
      providerLabel: formatProviderLabel(model.provider),
    });
  }

  for (const encodedId of visibleModels) {
    if (discoveredIds.has(encodedId)) {
      continue;
    }

    const decoded = decodePiModelId(encodedId);
    const provider = decoded?.provider ?? 'pi';
    enriched.push({
      description: 'Configured model',
      encodedId,
      isAvailable: false,
      modelLabel: decoded?.modelId ?? encodedId,
      providerKey: provider.toLowerCase(),
      providerLabel: formatProviderLabel(provider),
    });
  }

  return enriched.sort((left, right) => {
    const providerCmp = left.providerLabel.localeCompare(right.providerLabel);
    if (providerCmp !== 0) {
      return providerCmp;
    }
    return left.modelLabel.localeCompare(right.modelLabel);
  });
}

function buildPiModelDescription(model: PiDiscoveredModel): string {
  const details: string[] = [];
  if (model.api) {
    details.push(`API: ${model.api}`);
  }
  if (model.contextWindow) {
    details.push(`${model.contextWindow.toLocaleString()} context`);
  }
  if (model.maxTokens) {
    details.push(`${model.maxTokens.toLocaleString()} output`);
  }
  if (model.input.includes('image')) {
    details.push('image input');
  }
  details.push(model.reasoning
    ? `thinking: ${model.thinkingLevels.join(', ')}`
    : 'thinking: off');

  return details.join(' | ');
}

function formatProviderLabel(provider: string): string {
  const normalized = provider.trim();
  const knownProviders: Record<string, string> = {
    anthropic: 'Anthropic',
    deepseek: 'DeepSeek',
    google: 'Google',
    openai: 'OpenAI',
    xai: 'xAI',
  };
  const known = knownProviders[normalized.toLowerCase()];
  if (known) {
    return known;
  }

  return normalized
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ') || 'Pi';
}
