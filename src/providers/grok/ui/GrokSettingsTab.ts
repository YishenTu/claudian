import * as fs from 'node:fs';
import * as path from 'node:path';

import { Notice, Setting } from 'obsidian';

import { ProviderSettingsCoordinator } from '../../../core/providers/ProviderSettingsCoordinator';
import { ProviderWorkspaceRegistry } from '../../../core/providers/ProviderWorkspaceRegistry';
import type {
  ProviderSettingsTabRenderer,
  ProviderSettingsTabRendererContext,
  ProviderWorkspaceServices,
} from '../../../core/providers/types';
import type { ClaudianSettings } from '../../../core/types';
import { renderEnvironmentSettingsSection } from '../../../shared/settings/EnvironmentSettingsSection';
import {
  type ProviderModelPickerModel,
  type ProviderModelPickerState,
  renderProviderModelPicker,
} from '../../../shared/settings/ProviderModelPicker';
import { getHostnameKey } from '../../../utils/env';
import { expandHomePath } from '../../../utils/path';
import type { GrokDiscoveredModel } from '../models';
import {
  clearCurrentGrokCatalog,
  getGrokProviderSettings,
  normalizeGrokVisibleModels,
  updateGrokProviderSettings,
  updateGrokVisibleModels,
} from '../settings';

const GROK_PROVIDER_ID = 'grok' as const;

export const grokSettingsTabRenderer: ProviderSettingsTabRenderer = {
  render(container, context) {
    const settingsBag = context.plugin.settings as unknown as Record<string, unknown>;
    const initialSettings = getGrokProviderSettings(settingsBag);
    const hostnameKey = getHostnameKey();
    const workspace = getGrokWorkspaceServices();

    const refreshModelCatalog = async (): Promise<'empty' | 'failed' | 'loaded'> => {
      if (!workspace?.refreshModelCatalog) {
        return 'failed';
      }
      const result = await workspace.refreshModelCatalog();
      if (result.diagnostics) {
        new Notice(`Grok model discovery failed: ${result.diagnostics}`);
        return 'failed';
      }
      context.refreshModelSelectors();
      context.refreshTitleGenerationModelOptions();
      return (getGrokProviderSettings(settingsBag).currentCatalog?.models.length ?? 0) > 0
        ? 'loaded'
        : 'empty';
    };

    new Setting(container).setName('Setup').setHeading();

    new Setting(container)
      // Grok is a product name.
      // eslint-disable-next-line obsidianmd/ui/sentence-case
      .setName('Enable Grok')
      .setDesc('Launch `grok agent --no-leader stdio` as a provider.')
      .addToggle(toggle => toggle
        .setValue(initialSettings.enabled)
        .onChange(async (enabled) => {
          await context.plugin.mutateSettings((settings) => {
            ProviderSettingsCoordinator.applyProviderEnablement(
              settings,
              GROK_PROVIDER_ID,
              enabled,
            );
          });
          if (enabled) {
            await refreshModelCatalog();
          }
          context.refreshModelSelectors();
          context.refreshTitleGenerationModelOptions();
        }));

    const cliPathSetting = new Setting(container)
      .setName('CLI path')
      .setDesc('Optional absolute path to the Grok CLI for this computer. Leave empty to prefer known installs, then `grok` from PATH.');
    const validationEl = container.createDiv({
      cls: 'claudian-cli-path-validation claudian-setting-validation claudian-setting-validation-error claudian-hidden',
    });
    const cliPathsByHost = { ...initialSettings.cliPathsByHost };
    const initialCliPath = initialSettings.cliPathsByHost[hostnameKey]
      ?? initialSettings.cliPath
      ?? '';
    let currentCliPath = initialCliPath;
    let cliPathInputEl: HTMLInputElement | null = null;

    const updateCliPathValidation = (value: string, input?: HTMLInputElement): boolean => {
      const error = validateCliPath(value);
      if (error) {
        validationEl.setText(error);
        validationEl.toggleClass('claudian-hidden', false);
        input?.toggleClass('claudian-input-error', true);
        return false;
      }
      validationEl.toggleClass('claudian-hidden', true);
      input?.toggleClass('claudian-input-error', false);
      return true;
    };

    const resynchronizeCliPathState = (): void => {
      const persistedSettings = getGrokProviderSettings(settingsBag);
      for (const hostKey of Object.keys(cliPathsByHost)) {
        delete cliPathsByHost[hostKey];
      }
      Object.assign(cliPathsByHost, persistedSettings.cliPathsByHost);
      currentCliPath = persistedSettings.cliPathsByHost[hostnameKey]
        ?? persistedSettings.cliPath
        ?? '';
      if (cliPathInputEl) {
        cliPathInputEl.value = currentCliPath;
        updateCliPathValidation(currentCliPath, cliPathInputEl);
      }
    };

    const persistCliPath = async (value: string): Promise<void> => {
      if (!updateCliPathValidation(value, cliPathInputEl ?? undefined)) {
        return;
      }
      const trimmed = value.trim();
      if (trimmed === currentCliPath.trim()) {
        return;
      }
      if (trimmed) {
        cliPathsByHost[hostnameKey] = trimmed;
      } else {
        delete cliPathsByHost[hostnameKey];
      }

      const mutation = (settings: ClaudianSettings): void => {
        updateGrokProviderSettings(settings, {
          cliPath: '',
          cliPathsByHost: { ...cliPathsByHost },
        });
        clearCurrentGrokCatalog(settings);
      };
      try {
        if (context.plugin.mutateProviderSettingsAndRecycleRuntimes) {
          await context.plugin.mutateProviderSettingsAndRecycleRuntimes(
            GROK_PROVIDER_ID,
            mutation,
          );
        } else {
          await context.plugin.mutateSettings(mutation);
          workspace?.cliResolver?.reset();
          await context.plugin.recycleProviderRuntimes?.(GROK_PROVIDER_ID);
        }
      } catch (error) {
        resynchronizeCliPathState();
        throw error;
      }
      currentCliPath = trimmed;
      context.refreshModelSelectors();
      context.refreshTitleGenerationModelOptions();
    };

    cliPathSetting.addText(text => {
      text
        .setPlaceholder(process.platform === 'win32'
          ? 'C:\\Users\\you\\AppData\\Roaming\\npm\\grok.cmd'
          : '/usr/local/bin/grok')
        .setValue(initialCliPath)
        .onChange(persistCliPath);
      text.inputEl.addClass('claudian-settings-cli-path-input');
      cliPathInputEl = text.inputEl;
      updateCliPathValidation(initialCliPath, text.inputEl);
    });

    new Setting(container).setName('Authentication').setHeading();
    new Setting(container)
      .setName('Grok account')
      .setDesc('Run `grok login` in a terminal to use your existing grok.com account. Authentication stays in the Grok CLI; Claudian never requests or stores the token.');

    new Setting(container).setName('Models').setHeading();
    renderGrokModelPicker(container, context, settingsBag, refreshModelCatalog);

    new Setting(container).setName('Bring your own model').setHeading();
    new Setting(container)
      .setName('Grok-native custom models')
      // Grok, DeepSeek, Kimi, and GLM are product names.
      // eslint-disable-next-line obsidianmd/ui/sentence-case
      .setDesc('Define aliases and endpoints in Grok’s native ~/.grok/config.toml, reference secrets with env_key, and provide those variables in the Grok environment section below. DeepSeek, Kimi, and GLM configurations are documentation examples only; Claudian never writes Grok config.');

    new Setting(container).setName('Commands').setHeading();
    context.renderHiddenProviderCommandSetting(container, GROK_PROVIDER_ID, {
      name: 'Hidden Grok commands',
      desc: 'Hide runtime commands advertised by Grok from the command dropdown. Enter names without the leading slash, one per line.',
      placeholder: 'compact\nreview',
    });

    renderEnvironmentSettingsSection({
      container,
      desc: 'Environment variables passed only to Grok. Custom-model secrets stay in this provider scope and are referenced from native config by env_key.',
      heading: 'Environment',
      name: 'Grok environment variables',
      placeholder: 'GROK_HOME=/path/to/grok-home\nGROK_DEFAULT_MODEL=grok-code-fast-1',
      plugin: context.plugin,
      renderCustomContextLimits: target => context.renderCustomContextLimits(target, GROK_PROVIDER_ID),
      scope: 'provider:grok',
    });
  },
};

function renderGrokModelPicker(
  container: HTMLElement,
  context: ProviderSettingsTabRendererContext,
  settingsBag: Record<string, unknown>,
  loadCatalog: () => Promise<'empty' | 'failed' | 'loaded'>,
): void {
  const getState = (): ProviderModelPickerState => {
    const settings = getGrokProviderSettings(settingsBag);
    const catalogModels = settings.currentCatalog?.models ?? [];
    const selectedIds = settings.visibleModels ?? catalogModels.map(model => model.rawId);
    return {
      aliases: settings.modelAliases,
      discoveredCount: catalogModels.length,
      models: buildGrokPickerModels(catalogModels, selectedIds),
      selectedIds,
    };
  };

  renderProviderModelPicker({
    checkCatalogFreshnessWhenCached: true,
    container,
    emptyCatalogText: 'No Grok models discovered yet. Run `grok login` if needed, then click Discover.',
    failedCatalogText: 'Could not load the Grok model catalog. Check the CLI path, account login, and custom-model environment, then try again.',
    getState,
    initiallyOpen: (getGrokProviderSettings(settingsBag).currentCatalog?.models.length ?? 0) === 0,
    loadCatalog: async () => loadCatalog(),
    loadingCatalogText: 'Loading the Grok model catalog...',
    modifier: 'grok',
    async onAliasesChange(modelAliases) {
      await context.plugin.mutateSettings((settings) => {
        updateGrokProviderSettings(settings, { modelAliases });
      });
      context.refreshModelSelectors();
      context.refreshTitleGenerationModelOptions();
    },
    async onSelectedIdsChange(selectedIds) {
      const current = getGrokProviderSettings(settingsBag);
      const models = current.currentCatalog?.models ?? [];
      const allowedIds = new Set(models.map(model => model.rawId));
      const normalized = normalizeGrokVisibleModels(selectedIds, allowedIds, models.length > 0);
      const nextVisibleModels = representsWholeCatalog(normalized, models) ? null : normalized;
      if (sameOptionalList(current.visibleModels, nextVisibleModels)) {
        return;
      }
      await context.plugin.mutateSettings((settings) => {
        updateGrokVisibleModels(settings, nextVisibleModels);
      });
      context.refreshModelSelectors();
      context.refreshTitleGenerationModelOptions();
    },
    providerName: 'Grok',
    searchPlaceholder: 'Filter by model name, description, or alias ID...',
    settingDescription: 'Choose which discovered Grok models are available in Claudian. Grok is unavailable when no models are selected.',
  });
}

function buildGrokPickerModels(
  catalogModels: GrokDiscoveredModel[],
  selectedIds: string[],
): ProviderModelPickerModel[] {
  const models: ProviderModelPickerModel[] = catalogModels.map(model => ({
    description: model.description,
    id: model.rawId,
    isAvailable: true,
    name: model.displayName,
  }));
  const catalogIds = new Set(catalogModels.map(model => model.rawId));
  for (const rawId of selectedIds) {
    if (catalogIds.has(rawId)) {
      continue;
    }
    models.push({
      description: 'Selected model',
      id: rawId,
      isAvailable: false,
      name: rawId,
      unavailableMessage: 'Not currently reported by Grok',
    });
  }
  return models;
}

function representsWholeCatalog(
  selectedIds: string[] | null,
  catalogModels: GrokDiscoveredModel[],
): boolean {
  if (!selectedIds || selectedIds.length !== catalogModels.length) {
    return false;
  }
  const selected = new Set(selectedIds);
  return catalogModels.every(model => selected.has(model.rawId));
}

function sameOptionalList(left: string[] | null, right: string[] | null): boolean {
  if (left === null || right === null) {
    return left === right;
  }
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function validateCliPath(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  const expandedPath = expandHomePath(trimmed);
  if (!path.posix.isAbsolute(expandedPath) && !path.win32.isAbsolute(expandedPath)) {
    return 'Path must be absolute';
  }
  try {
    if (!fs.existsSync(expandedPath)) {
      return 'Path does not exist';
    }
    if (!fs.statSync(expandedPath).isFile()) {
      return 'Path must point to a file';
    }
    if (process.platform !== 'win32') {
      fs.accessSync(expandedPath, fs.constants.X_OK);
    }
  } catch {
    return process.platform === 'win32'
      ? 'Path is not accessible'
      : 'Path must be executable';
  }
  return null;
}

function getGrokWorkspaceServices(): ProviderWorkspaceServices | null {
  return ProviderWorkspaceRegistry.getServices(GROK_PROVIDER_ID);
}
