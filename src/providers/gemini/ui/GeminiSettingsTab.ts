import * as fs from 'fs';
import { Setting } from 'obsidian';

import type { ProviderSettingsTabRenderer } from '../../../core/providers/types';
import { renderEnvironmentSettingsSection } from '../../../features/settings/ui/EnvironmentSettingsSection';
import { getHostnameKey } from '../../../utils/env';
import { expandHomePath } from '../../../utils/path';
import { maybeGetGeminiWorkspaceServices } from '../app/GeminiWorkspaceServices';
import { clearGeminiDiscoveryState } from '../discoveryState';
import { sameStringList } from '../internal/compareCollections';
import {
  buildGeminiBaseModels,
  type GeminiDiscoveredModel,
  splitGeminiModelLabel,
} from '../models';
import {
  GEMINI_DEFAULT_ENVIRONMENT_VARIABLES,
  getGeminiProviderSettings,
  normalizeGeminiVisibleModels,
  updateGeminiProviderSettings,
} from '../settings';
import { GeminiAgentSettings } from './GeminiAgentSettings';

const ALL_PROVIDERS_KEY = 'all';

interface EnrichedModel {
  description: string;
  isAvailable: boolean;
  modelLabel: string;
  providerKey: string;
  providerLabel: string;
  rawId: string;
}

export const geminiSettingsTabRenderer: ProviderSettingsTabRenderer = {
  render(container, context) {
    const geminiWorkspace = maybeGetGeminiWorkspaceServices();
    const settingsBag = context.plugin.settings as unknown as Record<string, unknown>;
    const geminiSettings = getGeminiProviderSettings(settingsBag);
    const hostnameKey = getHostnameKey();

    new Setting(container).setName('Setup').setHeading();

    new Setting(container)
      .setName('Enable Gemini')
      .setDesc('Launch the official Gemini CLI in ACP mode as a provider.')
      .addToggle((toggle) =>
        toggle
          .setValue(geminiSettings.enabled)
          .onChange(async (value) => {
            updateGeminiProviderSettings(settingsBag, { enabled: value });
            await context.plugin.saveSettings();
            context.refreshModelSelectors();
          })
      );

    const cliPathSetting = new Setting(container)
      .setName(`CLI Path (${hostnameKey})`)
      .setDesc('Optional absolute path to the Gemini CLI for this computer. Leave empty to use `gemini` from PATH.');

    const validationEl = container.createDiv({ cls: 'claudian-cli-path-validation' });
    validationEl.style.color = 'var(--text-error)';
    validationEl.style.fontSize = '0.85em';
    validationEl.style.marginTop = '-0.5em';
    validationEl.style.marginBottom = '0.5em';
    validationEl.style.display = 'none';

    const validatePath = (value: string): string | null => {
      const trimmed = value.trim();
      if (!trimmed) {
        return null;
      }

      const expandedPath = expandHomePath(trimmed);
      if (!fs.existsSync(expandedPath)) {
        return 'Path does not exist';
      }

      const stat = fs.statSync(expandedPath);
      if (!stat.isFile()) {
        return 'Path must point to a file';
      }

      return null;
    };

    const updateCliPathValidation = (value: string, inputEl?: HTMLInputElement): boolean => {
      const error = validatePath(value);
      if (error) {
        validationEl.setText(error);
        validationEl.style.display = 'block';
        if (inputEl) {
          inputEl.style.borderColor = 'var(--text-error)';
        }
        return false;
      }

      validationEl.style.display = 'none';
      if (inputEl) {
        inputEl.style.borderColor = '';
      }
      return true;
    };

    const cliPathsByHost = { ...geminiSettings.cliPathsByHost };
    const currentValue = geminiSettings.cliPathsByHost[hostnameKey] || '';
    let cliPathInputEl: HTMLInputElement | null = null;

    const persistCliPath = async (value: string): Promise<boolean> => {
      const isValid = updateCliPathValidation(value, cliPathInputEl ?? undefined);
      if (!isValid) {
        return false;
      }

      const trimmed = value.trim();
      if (trimmed) {
        cliPathsByHost[hostnameKey] = trimmed;
      } else {
        delete cliPathsByHost[hostnameKey];
      }

      updateGeminiProviderSettings(settingsBag, { cliPathsByHost: { ...cliPathsByHost } });
      clearGeminiDiscoveryState(settingsBag);
      await context.plugin.saveSettings();
      geminiWorkspace?.cliResolver?.reset();
      await recycleGeminiRuntime();
      return true;
    };

    const recycleGeminiRuntime = async (): Promise<void> => {
      for (const view of context.plugin.getAllViews()) {
        const tabManager = view.getTabManager();
        if (tabManager?.broadcastToProviderTabs) {
          await tabManager.broadcastToProviderTabs('gemini', (service) => Promise.resolve(service.cleanup()));
        } else {
          await tabManager?.broadcastToAllTabs(
            (service) => Promise.resolve(service.cleanup()),
          );
        }
        view.invalidateProviderCommandCaches?.(['gemini']);
        view.refreshModelSelector?.();
      }
    };

    cliPathSetting.addText((text) => {
      text
        .setPlaceholder(process.platform === 'win32'
          ? 'C:\\Users\\you\\AppData\\Roaming\\npm\\gemini.cmd'
          : '/usr/local/bin/gemini')
        .setValue(currentValue)
        .onChange(async (value) => {
          await persistCliPath(value);
        });

      text.inputEl.addClass('claudian-settings-cli-path-input');
      text.inputEl.style.width = '100%';
      cliPathInputEl = text.inputEl;

      updateCliPathValidation(currentValue, text.inputEl);
    });

    new Setting(container).setName('Models').setHeading();

    new Setting(container)
      .setName('Visible Models')
      .setDesc('Choose which Gemini models appear in the chat selector. Filter by provider or type to search. The current session model stays pinned even if it is not selected here.');

    const pickerEl = container.createDiv({ cls: 'claudian-opencode-model-picker' });

    let searchQuery = '';
    let providerFilter = ALL_PROVIDERS_KEY;

    const summaryEl = pickerEl.createDiv({ cls: 'claudian-opencode-model-picker-summary' });
    const selectedEl = pickerEl.createDiv({ cls: 'claudian-opencode-model-picker-selected' });
    const catalogEl = pickerEl.createEl('details', { cls: 'claudian-opencode-model-picker-catalog' });
    catalogEl.open = getGeminiProviderSettings(settingsBag).visibleModels.length === 0;
    const catalogSummaryEl = catalogEl.createEl('summary', {
      cls: 'claudian-opencode-model-picker-catalog-summary',
    });
    catalogSummaryEl.createSpan({
      cls: 'claudian-opencode-model-picker-catalog-caret',
      text: '▸',
    });
    catalogSummaryEl.createSpan({
      cls: 'claudian-opencode-model-picker-catalog-title',
      text: 'Browse models',
    });
    const catalogSummaryCountEl = catalogSummaryEl.createSpan({
      cls: 'claudian-opencode-model-picker-catalog-count',
    });

    const controlsEl = catalogEl.createDiv({ cls: 'claudian-opencode-model-picker-controls' });

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

    const listEl = catalogEl.createDiv({ cls: 'claudian-opencode-model-picker-list' });

    const getEnrichedModels = (): EnrichedModel[] => {
      const current = getGeminiProviderSettings(settingsBag);
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
      const currentVisibleModels = getGeminiProviderSettings(settingsBag).visibleModels;
      const normalized = normalizeGeminiVisibleModels(
        visibleModels,
        getGeminiProviderSettings(settingsBag).discoveredModels,
      );
      if (sameStringList(currentVisibleModels, normalized)) {
        return;
      }

      updateGeminiProviderSettings(settingsBag, { visibleModels: normalized });
      await context.plugin.saveSettings();
      renderAll();
      context.refreshModelSelectors();
    };

    const persistModelAliases = async (modelAliases: Record<string, string>): Promise<void> => {
      updateGeminiProviderSettings(settingsBag, { modelAliases });
      await context.plugin.saveSettings();
      renderSelected();
      context.refreshModelSelectors();
    };

    const renderSummary = (): void => {
      summaryEl.empty();
      const current = getGeminiProviderSettings(settingsBag);
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

      catalogSummaryCountEl.setText(
        current.discoveredModels.length > 0
          ? `${current.discoveredModels.length} available`
          : 'No models discovered yet',
      );
    };

    const renderSelected = (): void => {
      selectedEl.empty();
      const current = getGeminiProviderSettings(settingsBag);
      if (current.visibleModels.length === 0) {
        selectedEl.style.display = 'none';
        return;
      }

      selectedEl.style.display = '';
      const enrichedByRawId = new Map(
        getEnrichedModels().map((model) => [model.rawId, model] as const),
      );

      const headerEl = selectedEl.createDiv({ cls: 'claudian-opencode-model-picker-selected-header' });
      headerEl.createEl('span', {
        cls: 'claudian-opencode-model-picker-selected-label',
        text: `Selected (${current.visibleModels.length})`,
      });
      const clearAllBtn = headerEl.createEl('button', {
        cls: 'claudian-opencode-model-picker-selected-clear',
        text: 'Clear all',
      });
      clearAllBtn.setAttribute('aria-label', 'Clear all selected models');
      clearAllBtn.addEventListener('click', () => {
        void persistVisibleModels([]);
      });

      const rowsEl = selectedEl.createDiv({ cls: 'claudian-opencode-model-picker-selected-rows' });

      for (const rawId of current.visibleModels) {
        const enriched = enrichedByRawId.get(rawId);
        const defaultLabel = enriched
          ? `${enriched.providerLabel}/${enriched.modelLabel}`
          : rawId;

        const rowEl = rowsEl.createDiv({ cls: 'claudian-opencode-model-picker-selected-row' });
        if (enriched && !enriched.isAvailable) {
          rowEl.classList.add('claudian-opencode-model-picker-selected-row--unavailable');
        }

        const infoEl = rowEl.createDiv({ cls: 'claudian-opencode-model-picker-selected-info' });
        const titleEl = infoEl.createDiv({ cls: 'claudian-opencode-model-picker-selected-title' });
        if (enriched) {
          titleEl.createEl('span', {
            cls: 'claudian-opencode-model-picker-selected-badge',
            text: enriched.providerLabel,
          });
          titleEl.createEl('span', {
            cls: 'claudian-opencode-model-picker-selected-name',
            text: enriched.modelLabel,
          });
        } else {
          titleEl.createEl('span', {
            cls: 'claudian-opencode-model-picker-selected-name',
            text: rawId,
          });
        }

        if (enriched && !enriched.isAvailable) {
          infoEl.createEl('div', {
            cls: 'claudian-opencode-model-picker-selected-unavailable',
            text: 'Not currently reported by Gemini',
          });
        }

        infoEl.createEl('div', {
          cls: 'claudian-opencode-model-picker-selected-id',
          text: rawId,
        });

        const controlsEl = rowEl.createDiv({ cls: 'claudian-opencode-model-picker-selected-controls' });
        const aliasInput = controlsEl.createEl('input', {
          cls: 'claudian-opencode-model-picker-selected-alias',
          type: 'text',
        });
        aliasInput.placeholder = defaultLabel;
        aliasInput.value = current.modelAliases[rawId] ?? '';
        aliasInput.setAttribute('aria-label', `Alias for ${defaultLabel}`);
        aliasInput.title = 'Custom label shown in the model selector. Leave empty to use the default.';

        const commitAlias = (): void => {
          const latest = getGeminiProviderSettings(settingsBag);
          const existing = latest.modelAliases[rawId] ?? '';
          const next = aliasInput.value.trim();
          if (next === existing) {
            aliasInput.value = existing;
            return;
          }

          const nextAliases = { ...latest.modelAliases };
          if (next) {
            nextAliases[rawId] = next;
          } else {
            delete nextAliases[rawId];
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
            aliasInput.value = getGeminiProviderSettings(settingsBag).modelAliases[rawId] ?? '';
            aliasInput.blur();
          }
        });

        const removeBtn = controlsEl.createEl('button', {
          cls: 'claudian-opencode-model-picker-selected-remove',
          text: '×',
        });
        removeBtn.setAttribute('aria-label', `Remove ${defaultLabel}`);
        removeBtn.addEventListener('click', () => {
          void persistVisibleModels(current.visibleModels.filter((entry) => entry !== rawId));
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
      const current = getGeminiProviderSettings(settingsBag);
      const selectedIds = new Set(current.visibleModels);
      const enriched = getEnrichedModels();
      const filtered = filterModels(enriched);

      if (filtered.length === 0) {
        const emptyEl = listEl.createDiv({ cls: 'claudian-opencode-model-picker-empty' });
        emptyEl.setText(enriched.length === 0
          ? 'Start Gemini once to load its model catalog. Claudian will then let you pick visible models.'
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
          const currentVisibleModels = getGeminiProviderSettings(settingsBag).visibleModels;
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
          badgeEl.title = 'Configured model not currently reported by Gemini';
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

    new Setting(container).setName('Commands and Skills').setHeading();

    const commandsDesc = container.createDiv({ cls: 'claudian-sp-settings-desc' });
    commandsDesc.createEl('p', {
      cls: 'setting-item-description',
      text: 'Gemini can auto-detect vault-level Claude slash commands from .claude/commands/ and skills from .claude/skills/, .codex/skills/, and .agents/skills/. Manage those entries in the Claude or Codex settings tab. This setting only hides entries from the Gemini dropdown.',
    });

    context.renderHiddenProviderCommandSetting(container, 'gemini', {
      name: 'Hidden Commands and Skills',
      desc: 'Hide specific Gemini commands and skills from the dropdown. Enter names without the leading slash, one per line.',
      placeholder: 'compact\nreview\nfix',
    });

    if (geminiWorkspace?.agentStorage) {
      new Setting(container).setName('Subagents').setHeading();

      const subagentsDesc = container.createDiv({ cls: 'claudian-sp-settings-desc' });
      subagentsDesc.createEl('p', {
        cls: 'setting-item-description',
        text: 'Manage vault-level Gemini subagents from .gemini/agent/ and legacy .gemini/agents/. New entries are saved as subagent-only files and appear in the @mention menu.',
      });

      const subagentsContainer = container.createDiv({ cls: 'claudian-slash-commands-container' });
      new GeminiAgentSettings(
        subagentsContainer,
        geminiWorkspace.agentStorage,
        context.plugin.app,
        async () => {
          await geminiWorkspace.refreshAgentMentions?.();
          await recycleGeminiRuntime();
        },
      );
    }

    renderEnvironmentSettingsSection({
      container,
      plugin: context.plugin,
      scope: 'provider:gemini',
      heading: 'Environment',
      name: 'Environment Variables',
      desc: 'Extra environment variables passed to Gemini CLI. Prefer API key or Vertex AI authentication for third-party agent integrations.',
      placeholder: GEMINI_DEFAULT_ENVIRONMENT_VARIABLES || 'GEMINI_API_KEY=...\nGOOGLE_GENAI_USE_VERTEXAI=true',
      renderCustomContextLimits: (target) => context.renderCustomContextLimits(target, 'gemini'),
    });
  },
};

function buildEnrichedModels(
  discoveredModels: GeminiDiscoveredModel[],
  visibleModels: string[],
): EnrichedModel[] {
  const enriched: EnrichedModel[] = [];
  const discoveredIds = new Set<string>();
  const baseModels = buildGeminiBaseModels(discoveredModels);

  for (const model of baseModels) {
    const { modelLabel, providerLabel } = splitGeminiModelLabel(model.label || model.rawId);
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

    const { modelLabel, providerLabel } = splitGeminiModelLabel(rawId);
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
