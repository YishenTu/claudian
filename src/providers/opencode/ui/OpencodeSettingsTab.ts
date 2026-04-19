import { Setting } from 'obsidian';

import type { ProviderSettingsTabRenderer } from '../../../core/providers/types';
import { renderEnvironmentSettingsSection } from '../../../features/settings/ui/EnvironmentSettingsSection';
import {
  type OpencodeDiscoveredModel,
  splitOpencodeModelLabel,
} from '../models';
import {
  getOpencodeProviderSettings,
  normalizeOpencodeVisibleModels,
  updateOpencodeProviderSettings,
} from '../settings';

const ALL_PROVIDERS_KEY = 'all';

interface EnrichedModel {
  description: string;
  isAvailable: boolean;
  modelLabel: string;
  providerKey: string;
  providerLabel: string;
  rawId: string;
}

export const opencodeSettingsTabRenderer: ProviderSettingsTabRenderer = {
  render(container, context) {
    const settingsBag = context.plugin.settings as unknown as Record<string, unknown>;
    const opencodeSettings = getOpencodeProviderSettings(settingsBag);

    new Setting(container).setName('Setup').setHeading();

    new Setting(container)
      .setName('Enable OpenCode')
      .setDesc('Launch `opencode acp` as a provider.')
      .addToggle((toggle) =>
        toggle
          .setValue(opencodeSettings.enabled)
          .onChange(async (value) => {
            updateOpencodeProviderSettings(settingsBag, { enabled: value });
            await context.plugin.saveSettings();
            context.refreshModelSelectors();
          })
      );

    new Setting(container)
      .setName('Prewarm Runtime')
      .setDesc('Create an OpenCode session as soon as the runtime is ready.')
      .addToggle((toggle) =>
        toggle
          .setValue(opencodeSettings.prewarm)
          .onChange(async (value) => {
            updateOpencodeProviderSettings(settingsBag, { prewarm: value });
            await context.plugin.saveSettings();
          })
      );

    new Setting(container)
      .setName('CLI Path')
      .setDesc('Optional absolute path to the OpenCode CLI. Leave empty to use `opencode` from PATH.')
      .addText((text) =>
        text
          .setPlaceholder('opencode')
          .setValue(opencodeSettings.cliPath)
          .onChange(async (value) => {
            updateOpencodeProviderSettings(settingsBag, { cliPath: value.trim() });
            await context.plugin.saveSettings();
          })
      );

    new Setting(container).setName('Models').setHeading();

    new Setting(container)
      .setName('Visible Models')
      .setDesc('Choose which OpenCode models appear in the chat selector. Filter by provider or type to search. The current session model stays pinned even if it is not selected here.');

    const pickerEl = container.createDiv({ cls: 'claudian-opencode-model-picker' });

    let searchQuery = '';
    let providerFilter = ALL_PROVIDERS_KEY;

    const summaryEl = pickerEl.createDiv({ cls: 'claudian-opencode-model-picker-summary' });
    const selectedEl = pickerEl.createDiv({ cls: 'claudian-opencode-model-picker-selected' });
    const controlsEl = pickerEl.createDiv({ cls: 'claudian-opencode-model-picker-controls' });

    const searchInput = controlsEl.createEl('input', {
      cls: 'claudian-opencode-model-picker-search',
      type: 'search',
    });
    searchInput.placeholder = 'Filter by model, provider, or id…';
    searchInput.addEventListener('input', () => {
      searchQuery = searchInput.value.trim().toLowerCase();
      renderList();
    });

    const providerSelectEl = controlsEl.createEl('select', {
      cls: 'claudian-opencode-model-picker-provider',
    });
    providerSelectEl.addEventListener('change', () => {
      providerFilter = providerSelectEl.value;
      renderList();
    });

    const actionsEl = controlsEl.createDiv({ cls: 'claudian-opencode-model-picker-actions' });

    const selectShownBtn = actionsEl.createEl('button', { text: 'Select shown' });
    selectShownBtn.addEventListener('click', () => {
      const shownIds = filterModels(getEnrichedModels()).map((model) => model.rawId);
      void persistVisibleModels([
        ...getOpencodeProviderSettings(settingsBag).visibleModels,
        ...shownIds,
      ]);
    });

    const unselectShownBtn = actionsEl.createEl('button', { text: 'Unselect shown' });
    unselectShownBtn.addEventListener('click', () => {
      const shownIds = new Set(filterModels(getEnrichedModels()).map((model) => model.rawId));
      const currentVisibleModels = getOpencodeProviderSettings(settingsBag).visibleModels;
      void persistVisibleModels(currentVisibleModels.filter((rawId) => !shownIds.has(rawId)));
    });

    const listEl = pickerEl.createDiv({ cls: 'claudian-opencode-model-picker-list' });

    const getEnrichedModels = (): EnrichedModel[] => {
      const current = getOpencodeProviderSettings(settingsBag);
      return buildEnrichedModels(current.discoveredModels, current.visibleModels);
    };

    const filterModels = (models: EnrichedModel[]): EnrichedModel[] => {
      return models.filter((model) => {
        if (providerFilter !== ALL_PROVIDERS_KEY && model.providerKey !== providerFilter) {
          return false;
        }

        if (!searchQuery) {
          return true;
        }

        return (
          model.rawId.toLowerCase().includes(searchQuery)
          || model.modelLabel.toLowerCase().includes(searchQuery)
          || model.providerLabel.toLowerCase().includes(searchQuery)
          || model.description.toLowerCase().includes(searchQuery)
        );
      });
    };

    const persistVisibleModels = async (visibleModels: string[]): Promise<void> => {
      const currentVisibleModels = getOpencodeProviderSettings(settingsBag).visibleModels;
      const normalized = normalizeOpencodeVisibleModels(visibleModels);
      if (sameStringList(currentVisibleModels, normalized)) {
        return;
      }

      updateOpencodeProviderSettings(settingsBag, { visibleModels: normalized });
      await context.plugin.saveSettings();
      renderAll();
      context.refreshModelSelectors();
    };

    const renderSummary = (): void => {
      summaryEl.empty();
      const current = getOpencodeProviderSettings(settingsBag);
      const enriched = getEnrichedModels();
      const providerCount = new Set(enriched.map((model) => model.providerKey)).size;
      const providerWord = providerCount === 1 ? 'provider' : 'providers';

      summaryEl.createSpan({ text: 'Visible: ' });
      summaryEl.createSpan({
        cls: 'claudian-opencode-model-picker-summary-value',
        text: String(current.visibleModels.length),
      });
      summaryEl.createSpan({
        text: ` of ${current.discoveredModels.length} discovered • ${providerCount} ${providerWord}`,
      });
    };

    const renderSelected = (): void => {
      selectedEl.empty();
      const current = getOpencodeProviderSettings(settingsBag);
      if (current.visibleModels.length === 0) {
        selectedEl.style.display = 'none';
        return;
      }

      selectedEl.style.display = '';
      const enrichedByRawId = new Map(
        getEnrichedModels().map((model) => [model.rawId, model] as const),
      );

      selectedEl.createEl('span', {
        cls: 'claudian-opencode-model-picker-selected-label',
        text: 'Selected',
      });

      for (const rawId of current.visibleModels) {
        const enriched = enrichedByRawId.get(rawId);
        const chipEl = selectedEl.createEl('span', {
          cls: 'claudian-opencode-model-picker-chip',
        });

        if (enriched && !enriched.isAvailable) {
          chipEl.classList.add('claudian-opencode-model-picker-chip--unavailable');
          chipEl.title = 'Configured model not currently reported by OpenCode';
        } else {
          chipEl.title = rawId;
        }

        const chipText = enriched
          ? `${enriched.providerLabel}/${enriched.modelLabel}`
          : rawId;
        chipEl.createEl('span', {
          cls: 'claudian-opencode-model-picker-chip-label',
          text: chipText,
        });

        const removeBtn = chipEl.createEl('button', {
          cls: 'claudian-opencode-model-picker-chip-remove',
          text: '×',
        });
        removeBtn.setAttribute('aria-label', `Remove ${rawId}`);
        removeBtn.addEventListener('click', () => {
          void persistVisibleModels(current.visibleModels.filter((entry) => entry !== rawId));
        });
      }

      const clearAllBtn = selectedEl.createEl('button', {
        cls: 'claudian-opencode-model-picker-chip-remove',
        text: 'Clear all',
      });
      clearAllBtn.style.padding = '2px 8px';
      clearAllBtn.style.width = 'auto';
      clearAllBtn.style.height = 'auto';
      clearAllBtn.setAttribute('aria-label', 'Clear all selected models');
      clearAllBtn.addEventListener('click', () => {
        void persistVisibleModels([]);
      });
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
      const current = getOpencodeProviderSettings(settingsBag);
      const selectedIds = new Set(current.visibleModels);
      const enriched = getEnrichedModels();
      const filtered = filterModels(enriched);

      if (filtered.length === 0) {
        const emptyEl = listEl.createDiv({ cls: 'claudian-opencode-model-picker-empty' });
        emptyEl.setText(enriched.length === 0
          ? 'Start OpenCode once to load its model catalog. Claudian will then let you pick visible models.'
          : 'No models match your filter.');
        return;
      }

      for (const model of filtered) {
        const rowEl = listEl.createEl('label', { cls: 'claudian-opencode-model-picker-row' });
        const isSelected = selectedIds.has(model.rawId);
        if (isSelected) {
          rowEl.classList.add('claudian-opencode-model-picker-row--selected');
        }
        rowEl.title = model.rawId;

        const checkboxEl = rowEl.createEl('input', { type: 'checkbox' });
        checkboxEl.checked = isSelected;
        checkboxEl.addEventListener('change', () => {
          const currentVisibleModels = getOpencodeProviderSettings(settingsBag).visibleModels;
          const next = checkboxEl.checked
            ? [...currentVisibleModels, model.rawId]
            : currentVisibleModels.filter((id) => id !== model.rawId);
          void persistVisibleModels(next);
        });

        const textEl = rowEl.createDiv({ cls: 'claudian-opencode-model-picker-row-text' });

        const headerEl = textEl.createDiv({ cls: 'claudian-opencode-model-picker-row-header' });
        headerEl.createEl('span', {
          cls: 'claudian-opencode-model-picker-row-name',
          text: model.modelLabel,
        });
        const badgeEl = headerEl.createEl('span', {
          cls: 'claudian-opencode-model-picker-row-badge',
          text: model.providerLabel,
        });
        if (!model.isAvailable) {
          badgeEl.classList.add('claudian-opencode-model-picker-row-badge--unavailable');
          badgeEl.setText('Unavailable');
          badgeEl.title = 'Configured model not currently reported by OpenCode';
        }

        textEl.createDiv({
          cls: 'claudian-opencode-model-picker-row-meta',
          text: model.rawId,
        });

        if (model.description) {
          textEl.createDiv({
            cls: 'claudian-opencode-model-picker-row-desc',
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

    renderAll();

    renderEnvironmentSettingsSection({
      container,
      plugin: context.plugin,
      scope: 'provider:opencode',
      heading: 'Environment',
      name: 'Environment Variables',
      desc: 'Extra environment variables passed to OpenCode.',
      placeholder: 'OPENCODE_DB=/path/to/opencode.db',
      renderCustomContextLimits: (target) => context.renderCustomContextLimits(target, 'opencode'),
    });
  },
};

function buildEnrichedModels(
  discoveredModels: OpencodeDiscoveredModel[],
  visibleModels: string[],
): EnrichedModel[] {
  const enriched: EnrichedModel[] = [];
  const discoveredIds = new Set<string>();

  for (const model of discoveredModels) {
    const { modelLabel, providerLabel } = splitOpencodeModelLabel(model.label || model.rawId);
    discoveredIds.add(model.rawId);
    enriched.push({
      description: model.description ?? '',
      isAvailable: true,
      modelLabel,
      providerKey: providerLabel.toLowerCase(),
      providerLabel,
      rawId: model.rawId,
    });
  }

  for (const rawId of visibleModels) {
    if (discoveredIds.has(rawId)) {
      continue;
    }

    const { modelLabel, providerLabel } = splitOpencodeModelLabel(rawId);
    enriched.push({
      description: '',
      isAvailable: false,
      modelLabel,
      providerKey: providerLabel.toLowerCase(),
      providerLabel,
      rawId,
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

function sameStringList(left: string[], right: string[]): boolean {
  if (left.length !== right.length) {
    return false;
  }

  return left.every((entry, index) => entry === right[index]);
}
