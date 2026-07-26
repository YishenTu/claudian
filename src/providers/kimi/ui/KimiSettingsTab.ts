import * as fs from 'node:fs';
import * as path from 'node:path';

import { Notice, Setting } from 'obsidian';

import { ProviderSettingsCoordinator } from '../../../core/providers/ProviderSettingsCoordinator';
import type {
  ProviderSettingsTabRenderer,
  ProviderSettingsTabRendererContext,
} from '../../../core/providers/types';
import { t } from '../../../i18n/i18n';
import { renderEnvironmentSettingsSection } from '../../../shared/settings/EnvironmentSettingsSection';
import {
  type ProviderModelPickerModel,
  type ProviderModelPickerState,
  renderProviderModelPicker,
} from '../../../shared/settings/ProviderModelPicker';
import { getHostnameKey } from '../../../utils/env';
import { expandHomePath } from '../../../utils/path';
import { maybeGetKimiWorkspaceServices } from '../app/KimiWorkspaceServices';
import { clearKimiDiscoveryState, getKimiDiscoveryState } from '../discoveryState';
import type { KimiDiscoveredModel } from '../models';
import { getKimiProviderSettings, updateKimiProviderSettings } from '../settings';

const KIMI_PROVIDER_ID = 'kimi' as const;

export const kimiSettingsTabRenderer: ProviderSettingsTabRenderer = {
  render(container, context) {
    const settingsBag = context.plugin.settings as unknown as Record<string, unknown>;
    const kimiSettings = getKimiProviderSettings(settingsBag);
    const hostnameKey = getHostnameKey();
    const workspace = maybeGetKimiWorkspaceServices();

    const refreshModelCatalog = async (): Promise<'empty' | 'failed' | 'loaded'> => {
      if (!workspace?.refreshModelCatalog) {
        return 'failed';
      }
      const result = await workspace.refreshModelCatalog();
      if (result.diagnostics) {
        new Notice(`Kimi model discovery failed: ${result.diagnostics}`);
        return 'failed';
      }
      context.notifyProviderModelOptionsChanged(KIMI_PROVIDER_ID);
      return getKimiDiscoveryState(settingsBag).discoveredModels.length > 0 ? 'loaded' : 'empty';
    };

    new Setting(container).setName('Setup').setHeading();

    new Setting(container)
      .setName(t('settings.providerEnablement.name', { provider: 'Kimi' }))
      .setDesc(t('settings.providerEnablement.desc', { provider: 'Kimi' }))
      .addToggle((toggle) =>
        toggle
          .setValue(kimiSettings.enabled)
          .onChange(async (value) => {
            await context.plugin.mutateSettings((settings) => {
              ProviderSettingsCoordinator.applyProviderEnablement(settings, KIMI_PROVIDER_ID, value);
            });
            if (value) {
              await refreshModelCatalog();
            }
            context.notifyProviderModelOptionsChanged(KIMI_PROVIDER_ID);
          })
      );

    const cliPathSetting = new Setting(container)
      .setName('CLI path')
      .setDesc('Optional absolute path to the Kimi CLI for this computer. Leave empty to use `kimi` from PATH.');

    const validationEl = container.createDiv({
      cls: 'claudian-cli-path-validation claudian-setting-validation claudian-setting-validation-error claudian-hidden',
    });
    const cliPathsByHost = { ...kimiSettings.cliPathsByHost };
    const currentValue = cliPathsByHost[hostnameKey] || '';
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

    const detectionSetting = new Setting(container).setName('Detected CLI');
    const updateDetectionStatus = (): void => {
      detectionSetting.setDesc('Detecting the CLI...');
      void Promise.resolve(workspace?.cliResolver?.resolveFromSettings(settingsBag) ?? null)
        .then((resolved) => {
          detectionSetting.setDesc(resolved
            ? `Using ${resolved}`
            : 'The `kimi` binary was not found on PATH. Install Kimi Code or set a CLI path above.');
        });
    };

    const persistCliPath = async (value: string): Promise<boolean> => {
      if (!updateCliPathValidation(value, cliPathInputEl ?? undefined)) {
        return false;
      }

      const trimmed = value.trim();
      if (trimmed) {
        cliPathsByHost[hostnameKey] = trimmed;
      } else {
        delete cliPathsByHost[hostnameKey];
      }

      await context.plugin.mutateSettings((settings) => {
        updateKimiProviderSettings(settings, { cliPathsByHost: { ...cliPathsByHost } });
        clearKimiDiscoveryState(settings);
      });
      workspace?.cliResolver?.reset();
      await context.plugin.recycleProviderRuntimes?.(KIMI_PROVIDER_ID);
      updateDetectionStatus();
      return true;
    };

    cliPathSetting.addText((text) => {
      text
        .setPlaceholder(process.platform === 'win32'
          ? 'C:\\Users\\you\\AppData\\Roaming\\npm\\kimi.cmd'
          : '/usr/local/bin/kimi')
        .setValue(currentValue)
        .onChange(async (value) => {
          await persistCliPath(value);
        });
      text.inputEl.addClass('claudian-settings-cli-path-input');
      cliPathInputEl = text.inputEl;
      updateCliPathValidation(currentValue, text.inputEl);
    });

    updateDetectionStatus();

    new Setting(container).setName('Models').setHeading();
    renderKimiModelPicker(container, context, settingsBag, refreshModelCatalog);

    new Setting(container).setName(t('settings.agentSkills.sectionTitle')).setHeading();
    context.renderAgentSkillSettings(container, KIMI_PROVIDER_ID);

    new Setting(container).setName('Commands').setHeading();
    context.renderHiddenProviderCommandSetting(container, KIMI_PROVIDER_ID, {
      name: 'Hidden commands and skills',
      desc: 'Hide specific Kimi commands and skills from the dropdown. Enter names without the leading slash, one per line.',
      placeholder: 'compact\ninit',
    });

    renderEnvironmentSettingsSection({
      container,
      plugin: context.plugin,
      scope: 'provider:kimi',
      heading: 'Environment',
      name: 'Environment variables',
      desc: 'Extra environment variables passed to Kimi. Kimi owns ~/.kimi-code/config.toml and ~/.kimi-code/mcp.json; Claudian never writes them.',
      placeholder: 'KIMI_LOG_LEVEL=debug\nKIMI_CODE_HOME=/path/to/kimi-home',
      renderCustomContextLimits: (target) => context.renderCustomContextLimits(target, KIMI_PROVIDER_ID),
    });
  },
};

function renderKimiModelPicker(
  container: HTMLElement,
  context: ProviderSettingsTabRendererContext,
  settingsBag: Record<string, unknown>,
  loadCatalog: () => Promise<'empty' | 'failed' | 'loaded'>,
): void {
  const getState = (): ProviderModelPickerState => {
    const current = getKimiProviderSettings(settingsBag);
    const discoveredModels = getKimiDiscoveryState(settingsBag).discoveredModels;
    const selectedIds = current.visibleModels ?? discoveredModels.map((model) => model.rawId);
    return {
      aliases: current.modelAliases,
      discoveredCount: discoveredModels.length,
      models: buildKimiPickerModels(discoveredModels, selectedIds),
      selectedIds,
    };
  };

  renderProviderModelPicker({
    container,
    emptyCatalogText: 'Start Kimi once to load its model catalog. Claudian will then let you pick visible models.',
    failedCatalogText: 'Could not load the Kimi model catalog. Check the CLI path and login state, then try again.',
    getState,
    loadCatalog: async () => loadCatalog(),
    loadCatalogOnRender: true,
    loadingCatalogText: 'Loading Kimi model catalog...',
    modifier: 'kimi',
    async onAliasesChange(modelAliases) {
      await context.plugin.mutateSettings((settings) => {
        updateKimiProviderSettings(settings, { modelAliases });
      });
      context.notifyProviderModelOptionsChanged(KIMI_PROVIDER_ID);
    },
    async onSelectedIdsChange(selectedIds) {
      const current = getKimiProviderSettings(settingsBag);
      const discoveredModels = getKimiDiscoveryState(settingsBag).discoveredModels;
      const discoveredIds = new Set(discoveredModels.map((model) => model.rawId));
      const normalized = discoveredIds.size > 0
        ? selectedIds.filter((id) => discoveredIds.has(id))
        : selectedIds;
      const nextVisibleModels = representsWholeCatalog(normalized, discoveredIds)
        ? null
        : normalized;
      if (sameOptionalList(current.visibleModels, nextVisibleModels)) {
        return;
      }

      await context.plugin.mutateSettings((settings) => {
        updateKimiProviderSettings(settings, { visibleModels: nextVisibleModels });
      });
      context.notifyProviderModelOptionsChanged(KIMI_PROVIDER_ID);
    },
    providerName: 'Kimi',
    settingDescription: 'Choose which Kimi models are available in the chat selector. Filter or type to search. Kimi uses its configured default model when no models are selected.',
  });
}

function buildKimiPickerModels(
  discoveredModels: KimiDiscoveredModel[],
  selectedIds: string[],
): ProviderModelPickerModel[] {
  const models: ProviderModelPickerModel[] = discoveredModels.map((model) => ({
    description: model.description ?? '',
    id: model.rawId,
    isAvailable: true,
    name: model.label || model.rawId,
  }));
  const discoveredIds = new Set(discoveredModels.map((model) => model.rawId));
  for (const rawId of selectedIds) {
    if (discoveredIds.has(rawId)) {
      continue;
    }
    models.push({
      id: rawId,
      isAvailable: false,
      name: rawId,
      unavailableMessage: 'Not currently reported by Kimi',
    });
  }
  return models;
}

function representsWholeCatalog(
  selectedIds: string[],
  discoveredIds: ReadonlySet<string>,
): boolean {
  return discoveredIds.size > 0
    && selectedIds.length === discoveredIds.size
    && selectedIds.every((id) => discoveredIds.has(id));
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
