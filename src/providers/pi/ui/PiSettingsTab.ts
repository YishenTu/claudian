import * as fs from 'node:fs';

import { Notice, Setting } from 'obsidian';

import type { ProviderSettingsTabRenderer } from '../../../core/providers/types';
import { renderEnvironmentSettingsSection } from '../../../features/settings/ui/EnvironmentSettingsSection';
import { getHostnameKey } from '../../../utils/env';
import { expandHomePath } from '../../../utils/path';
import { maybeGetPiWorkspaceServices } from '../app/PiWorkspaceServices';
import { sameStringList } from '../internal/compareCollections';
import { PiModelDiscoveryService } from '../runtime/PiModelDiscoveryService';
import {
  getPiProviderSettings,
  normalizePiVisibleModels,
  updatePiProviderSettings,
} from '../settings';

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

    const modelContainer = container.createDiv({ cls: 'claudian-pi-models' });
    const renderModels = (): void => {
      modelContainer.empty();
      const current = getPiProviderSettings(settingsBag);
      new Setting(modelContainer)
        .setName('Discover models')
        .setDesc(current.discoveredModels.length > 0
          ? `${current.discoveredModels.length} Pi models cached.`
          : 'Fetch models from `pi --mode rpc --no-session`.')
        .addButton((button) => {
          button.setButtonText('Discover').onClick(async () => {
            button.setDisabled(true);
            const result = await new PiModelDiscoveryService(context.plugin).discoverModels();
            if (result.diagnostics) {
              new Notice(`Pi discovery failed: ${result.diagnostics}`);
              button.setDisabled(false);
              return;
            }
            updatePiProviderSettings(settingsBag, {
              discoveredModels: result.models,
              visibleModels: normalizePiVisibleModels(
                current.visibleModels,
                result.models,
              ),
            });
            await context.plugin.saveSettings();
            renderModels();
            context.refreshModelSelectors();
          });
        });

      if (current.discoveredModels.length === 0) {
        modelContainer.createDiv({
          cls: 'setting-item-description',
          text: 'No Pi models discovered yet.',
        });
        return;
      }

      for (const model of current.discoveredModels) {
        new Setting(modelContainer)
          .setName(current.modelAliases[model.encodedId] || model.label)
          .setDesc(model.encodedId)
          .addToggle((toggle) => {
            toggle
              .setValue(current.visibleModels.includes(model.encodedId))
              .onChange(async (value) => {
                const visibleModels = value
                  ? [...current.visibleModels, model.encodedId]
                  : current.visibleModels.filter(id => id !== model.encodedId);
                const normalized = normalizePiVisibleModels(visibleModels, current.discoveredModels);
                if (!sameStringList(current.visibleModels, normalized)) {
                  updatePiProviderSettings(settingsBag, { visibleModels: normalized });
                  await context.plugin.saveSettings();
                  renderModels();
                  context.refreshModelSelectors();
                }
              });
          })
          .addText((text) => {
            text
              .setPlaceholder('Alias')
              .setValue(current.modelAliases[model.encodedId] ?? '')
              .onChange(async (value) => {
                updatePiProviderSettings(settingsBag, {
                  modelAliases: {
                    ...getPiProviderSettings(settingsBag).modelAliases,
                    [model.encodedId]: value,
                  },
                });
                await context.plugin.saveSettings();
                context.refreshModelSelectors();
              });
          });
      }
    };
    renderModels();

    new Setting(container)
      .setName('Tool mode')
      .setDesc('Controls whether Pi gets all configured tools or read-only tools.')
      .addDropdown((dropdown) => {
        dropdown
          .addOption('all', 'All tools')
          .addOption('readonly', 'Read-only')
          .setValue(piSettings.toolMode)
          .onChange(async (value) => {
            updatePiProviderSettings(settingsBag, {
              toolMode: value === 'readonly' ? 'readonly' : 'all',
            });
            await context.plugin.saveSettings();
          });
      });

    context.renderHiddenProviderCommandSetting(container, 'pi', {
      desc: 'Hide Pi runtime commands by name.',
      name: 'Hidden Pi commands',
      placeholder: 'review, tests',
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
