import * as fs from 'node:fs';

import { Notice, Setting } from 'obsidian';

import { ProviderSettingsCoordinator } from '../../../core/providers/ProviderSettingsCoordinator';
import type {
  ProviderSettingsTabRenderer,
  ProviderSettingsTabRendererContext,
} from '../../../core/providers/types';
import { renderEnvironmentSettingsSection } from '../../../shared/settings/EnvironmentSettingsSection';
import {
  type ProviderModelPickerModel,
  type ProviderModelPickerState,
  renderProviderModelPicker,
} from '../../../shared/settings/ProviderModelPicker';
import { getHostnameKey } from '../../../utils/env';
import { expandHomePath } from '../../../utils/path';
import { getQoderWorkspaceServices } from '../app/QoderWorkspaceServices';
import type { QoderDiscoveredModel } from '../models';
import {
  getQoderProviderSettings,
  normalizeQoderVisibleModels,
  updateQoderProviderSettings,
} from '../settings';

export const qoderSettingsTabRenderer: ProviderSettingsTabRenderer = {
  render(container, context) {
    const settingsBag = context.plugin.settings as unknown as Record<string, unknown>;
    const qoderSettings = getQoderProviderSettings(settingsBag);
    const hostnameKey = getHostnameKey();
    const workspace = getQoderWorkspaceServices();

    new Setting(container).setName('Setup').setHeading();

    new Setting(container)
      .setName('Enable Qoder')
      .setDesc('Enable the Qoder provider in model selectors and chat tabs.')
      .addToggle((toggle) => toggle
        .setValue(qoderSettings.enabled)
        .onChange(async (value) => {
          await context.plugin.mutateSettings((settings) => {
            ProviderSettingsCoordinator.applyProviderEnablement(settings, 'qoder', value);
          });
          if (value) {
            const result = await workspace.refreshModelCatalog();
            if (result.diagnostics) {
              new Notice(`Qoder model discovery failed: ${result.diagnostics}`);
            }
          }
          context.refreshModelSelectors();
          context.refreshTitleGenerationModelOptions();
        }));

    const validationEl = container.createDiv({
      cls: 'claudian-cli-path-validation claudian-setting-validation claudian-setting-validation-error claudian-hidden',
    });
    const cliPathsByHost = { ...qoderSettings.cliPathsByHost };
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

      await context.plugin.mutateSettings((settings) => {
        updateQoderProviderSettings(settings, {
          cliPathsByHost: { ...cliPathsByHost },
          discoveredModels: [],
          visibleModels: [],
        });
        workspace.cliResolver.reset();
      });
      context.refreshModelSelectors();
      context.refreshTitleGenerationModelOptions();
    };

    new Setting(container)
      .setName('CLI path')
      .setDesc('Optional absolute path to qodercli for this computer. Leave empty to use `qodercli` from PATH.')
      .addText((text) => {
        const currentValue = qoderSettings.cliPathsByHost[hostnameKey] || '';
        text
          .setPlaceholder(process.platform === 'win32'
            ? 'C:\\Users\\you\\AppData\\Roaming\\npm\\qodercli.cmd'
            : '/usr/local/bin/qodercli')
          .setValue(currentValue)
          .onChange((value) => {
            void persistCliPath(value);
          });
        cliPathInputEl = text.inputEl;
        updateCliPathValidation(currentValue, text.inputEl);
      });

    new Setting(container)
      .setName('Authentication')
      .setDesc('Prefer qodercli login by default. PAT can be provided via provider-scoped environment variables.')
      .addDropdown((dropdown) => {
        dropdown
          .addOption('auto', 'Auto')
          .addOption('qodercli', 'qodercli login')
          .addOption('pat-env', 'PAT from env')
          .setValue(qoderSettings.authMode)
          .onChange(async (value) => {
            await context.plugin.mutateSettings((settings) => {
              updateQoderProviderSettings(settings, { authMode: value as 'auto' | 'qodercli' | 'pat-env' });
            });
          });
      });

    new Setting(container)
      .setName('Default permission mode')
      .setDesc('Select the Qoder permission mode used for new chat turns.')
      .addDropdown((dropdown) => {
        for (const value of ['default', 'acceptEdits', 'bypassPermissions', 'yolo', 'plan', 'dontAsk', 'auto']) {
          dropdown.addOption(value, value);
        }
        dropdown
          .setValue(qoderSettings.selectedPermissionMode)
          .onChange(async (value) => {
            await context.plugin.mutateSettings((settings) => {
              updateQoderProviderSettings(settings, { selectedPermissionMode: value });
            });
          });
      });

    new Setting(container)
      .setName('File checkpointing')
      .setDesc('Enable Qoder file checkpoints so rewind can restore files to a previous user message.')
      .addToggle((toggle) => toggle
        .setValue(qoderSettings.checkpointingEnabled)
        .onChange(async (value) => {
          await context.plugin.mutateSettings((settings) => {
            updateQoderProviderSettings(settings, { checkpointingEnabled: value });
          });
        }));

    new Setting(container).setName('Models').setHeading();
    renderQoderModelPicker(container, context, settingsBag);

    new Setting(container).setName('Agent skills').setHeading();
    context.renderAgentSkillSettings(container, 'qoder');

    new Setting(container).setName('Commands').setHeading();
    context.renderHiddenProviderCommandSetting(container, 'qoder', {
      name: 'Hidden Qoder commands and skills',
      desc: 'Hide runtime commands and skills discovered from qodercli. Enter exact names without leading slash or dollar sign, one per line.',
      placeholder: 'compact\nskill:review',
    });

    renderEnvironmentSettingsSection({
      container,
      desc: 'Environment variables passed only to Qoder. Put PAT here if you want to authenticate via env, for example `QODER_PERSONAL_ACCESS_TOKEN=...`.',
      heading: 'Environment',
      name: 'Qoder environment variables',
      placeholder: 'QODER_PERSONAL_ACCESS_TOKEN=...\nQODER_CONFIG_DIR=/path/to/config',
      plugin: context.plugin,
      renderCustomContextLimits: target => context.renderCustomContextLimits(target, 'qoder'),
      scope: 'provider:qoder',
    });
  },
};

function renderQoderModelPicker(
  container: HTMLElement,
  context: ProviderSettingsTabRendererContext,
  settingsBag: Record<string, unknown>,
): void {
  const workspace = getQoderWorkspaceServices();
  const getState = (): ProviderModelPickerState => {
    const current = getQoderProviderSettings(settingsBag);
    const selectedIds = current.visibleModels;
    return {
      aliases: current.modelAliases,
      discoveredCount: current.discoveredModels.length,
      models: buildQoderPickerModels(current.discoveredModels, selectedIds),
      selectedIds,
    };
  };

  renderProviderModelPicker({
    container,
    emptyCatalogText: 'No Qoder models discovered yet. Run `qodercli login` if needed, then click Discover.',
    failedCatalogText: 'Could not load the Qoder model catalog. Check the CLI path, authentication, and environment settings, then try again.',
    getState,
    async loadCatalog() {
      const result = await workspace.refreshModelCatalog();
      if (result.diagnostics) {
        new Notice(`Qoder model discovery failed: ${result.diagnostics}`);
        return 'failed';
      }
      context.refreshModelSelectors();
      context.refreshTitleGenerationModelOptions();
      return getQoderProviderSettings(settingsBag).discoveredModels.length > 0 ? 'loaded' : 'empty';
    },
    loadingCatalogText: 'Loading the Qoder model catalog...',
    modifier: 'qoder',
    async onAliasesChange(modelAliases) {
      await context.plugin.mutateSettings((settings) => {
        updateQoderProviderSettings(settings, { modelAliases });
      });
      context.refreshModelSelectors();
      context.refreshTitleGenerationModelOptions();
    },
    async onSelectedIdsChange(visibleModels) {
      const current = getQoderProviderSettings(settingsBag);
      const normalized = normalizeQoderVisibleModels(visibleModels, current.discoveredModels);
      await context.plugin.mutateSettings((settings) => {
        updateQoderProviderSettings(settings, { visibleModels: normalized });
      });
      context.refreshModelSelectors();
      context.refreshTitleGenerationModelOptions();
    },
    providerName: 'Qoder',
    settingDescription: 'Choose which Qoder models are available in Claudian.',
  });
}

function buildQoderPickerModels(
  discoveredModels: readonly QoderDiscoveredModel[],
  _selectedIds: readonly string[],
): ProviderModelPickerModel[] {
  return discoveredModels.map(model => ({
    description: model.description,
    id: `qoder/${model.rawId}`,
    name: model.displayName,
    ...(model.isDefault ? { catalogBadge: 'default' } : {}),
    ...(model.supportsReasoning ? { providerLabel: 'Reasoning' } : {}),
  }));
}

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
