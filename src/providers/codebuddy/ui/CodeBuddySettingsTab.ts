import * as fs from 'node:fs';

import { Setting } from 'obsidian';

import type { ProviderSettingsTabRenderer } from '../../../core/providers/types';
import { renderEnvironmentSettingsSection } from '../../../features/settings/ui/EnvironmentSettingsSection';
import { getHostnameKey } from '../../../utils/env';
import { expandHomePath } from '../../../utils/path';
import { maybeGetCodeBuddyWorkspaceServices } from '../app/CodeBuddyWorkspaceServices';
import { formatCodeBuddyModelLabel } from '../models';
import { getCodeBuddyProviderSettings, updateCodeBuddyProviderSettings } from '../settings';

export const codeBuddySettingsTabRenderer: ProviderSettingsTabRenderer = {
  render(container, context) {
    const workspace = maybeGetCodeBuddyWorkspaceServices();
    const settingsBag = context.plugin.settings as unknown as Record<string, unknown>;
    const codeBuddySettings = getCodeBuddyProviderSettings(settingsBag);
    const hostnameKey = getHostnameKey();

    new Setting(container).setName('Setup').setHeading();

    new Setting(container)
      .setName('Enable CodeBuddy')
      .setDesc('Launch `codebuddy --acp` as a provider.')
      .addToggle((toggle) =>
        toggle
          .setValue(codeBuddySettings.enabled)
          .onChange(async (value) => {
            updateCodeBuddyProviderSettings(settingsBag, { enabled: value });
            await context.plugin.saveSettings();
            context.refreshModelSelectors();
          })
      );

    const validationEl = container.createDiv({
      cls: 'claudian-cli-path-validation claudian-setting-validation claudian-setting-validation-error claudian-hidden',
    });
    const cliPathsByHost = { ...codeBuddySettings.cliPathsByHost };
    const currentValue = codeBuddySettings.cliPathsByHost[hostnameKey] || '';
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

      updateCodeBuddyProviderSettings(settingsBag, {
        cliPathsByHost: { ...cliPathsByHost },
        discoveredModels: [],
        visibleModels: [],
      });
      workspace?.cliResolver?.reset();
      await context.plugin.saveSettings();
      context.refreshModelSelectors();
    };

    new Setting(container)
      .setName('CLI path')
      .setDesc('Optional absolute path to the CodeBuddy CLI for this computer. Leave empty to use `codebuddy`/`cbc` from PATH.')
      .addText((text) => {
        text
          .setPlaceholder(process.platform === 'win32'
            ? 'C:\\Users\\you\\AppData\\Roaming\\npm\\codebuddy.cmd'
            : '/usr/local/bin/codebuddy')
          .setValue(currentValue)
          .onChange((value) => {
            void persistCliPath(value);
          });
        cliPathInputEl = text.inputEl;
        updateCliPathValidation(currentValue, text.inputEl);
      });

    new Setting(container).setName('Models').setHeading();
    const modelSummary = codeBuddySettings.discoveredModels.length === 0
      ? 'Models are discovered after the first CodeBuddy session starts.'
      : `${codeBuddySettings.discoveredModels.length} models discovered from CodeBuddy Code.`;
    new Setting(container)
      .setName('Discovered models')
      .setDesc(modelSummary);

    if (codeBuddySettings.discoveredModels.length > 0) {
      const visibleSet = new Set(codeBuddySettings.visibleModels);
      for (const model of codeBuddySettings.discoveredModels) {
        new Setting(container)
          .setName(codeBuddySettings.modelAliases[model.rawId] || model.label || formatCodeBuddyModelLabel(model.rawId))
          .setDesc(model.rawId)
          .addToggle((toggle) =>
            toggle
              .setValue(visibleSet.has(model.rawId))
              .onChange(async (value) => {
                const nextVisible = new Set(getCodeBuddyProviderSettings(settingsBag).visibleModels);
                if (value) {
                  nextVisible.add(model.rawId);
                } else {
                  nextVisible.delete(model.rawId);
                }
                updateCodeBuddyProviderSettings(settingsBag, { visibleModels: [...nextVisible] });
                await context.plugin.saveSettings();
                context.refreshModelSelectors();
              })
          );
      }
    }

    renderEnvironmentSettingsSection({
      container,
      plugin: context.plugin,
      scope: 'provider:codebuddy',
      heading: 'Environment',
      name: 'CodeBuddy environment variables',
      desc: 'Environment variables applied only when launching CodeBuddy Code.',
      placeholder: 'CODEBUDDY_DISABLE_AUTOUPDATE=1',
      renderCustomContextLimits: (limitsContainer) => context.renderCustomContextLimits(limitsContainer, 'codebuddy'),
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
