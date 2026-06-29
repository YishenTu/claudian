import * as fs from 'fs';
import { Setting } from 'obsidian';

import type { ProviderSettingsTabRenderer } from '../../../core/providers/types';
import { renderEnvironmentSettingsSection } from '../../../features/settings/ui/EnvironmentSettingsSection';
import { getHostnameKey } from '../../../utils/env';
import { expandHomePath } from '../../../utils/path';
import {
  getHermesProviderSettings,
  HERMES_DEFAULT_ENVIRONMENT_VARIABLES,
  updateHermesProviderSettings,
} from '../settings';

export const hermesSettingsTabRenderer: ProviderSettingsTabRenderer = {
  render(container, context) {
    const settingsBag = context.plugin.settings as unknown as Record<string, unknown>;
    const hermesSettings = getHermesProviderSettings(settingsBag);
    const hostnameKey = getHostnameKey();

    new Setting(container).setName('Setup').setHeading();

    new Setting(container)
      .setName('Enable Hermes')
      .setDesc('Launch `hermes acp` as a provider. Requires Hermes Agent installed with ACP extra.')
      .addToggle((toggle) =>
        toggle
          .setValue(hermesSettings.enabled)
          .onChange(async (value) => {
            updateHermesProviderSettings(settingsBag, { enabled: value });
            await context.plugin.saveSettings();
            context.refreshModelSelectors();
          })
      );

    const cliPathSetting = new Setting(container)
      .setName('CLI path')
      .setDesc('Optional absolute path to the Hermes CLI for this computer. Leave empty to use `hermes` from PATH.');

    const validationEl = container.createDiv({
      cls: 'claudian-cli-path-validation claudian-setting-validation claudian-setting-validation-error claudian-hidden',
    });

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
        return 'Path is not a file';
      }

      return null;
    };

    const currentHostCliPath = hermesSettings.cliPathsByHost[hostnameKey]
      || hermesSettings.cliPath;

    cliPathSetting.addText((text) =>
      text
        .setValue(currentHostCliPath)
        .setPlaceholder('hermes')
        .onChange(async (value) => {
          const error = validatePath(value);
          if (error) {
            validationEl.setText(error);
            validationEl.removeClass('claudian-hidden');
          } else {
            validationEl.addClass('claudian-hidden');
          }

          updateHermesProviderSettings(settingsBag, { cliPath: value.trim() });
          await context.plugin.saveSettings();
        })
    );

    new Setting(container)
      .setName('Agent profile')
      .setDesc('Optional Hermes agent profile name. Passed as `--profile` when starting `hermes acp`.')
      .addText((text) =>
        text
          .setValue(hermesSettings.profile)
          .setPlaceholder('default')
          .onChange(async (value) => {
            updateHermesProviderSettings(settingsBag, { profile: value.trim() });
            await context.plugin.saveSettings();
          })
      );

    new Setting(container).setName('Configuration').setHeading();

    renderEnvironmentSettingsSection({
      container,
      plugin: context.plugin,
      scope: 'provider:hermes',
      name: 'Hermes environment',
      desc: 'Hermes-specific environment variables applied to all sessions.',
      placeholder: HERMES_DEFAULT_ENVIRONMENT_VARIABLES,
    });

    new Setting(container).setName('Models').setHeading();

    const visibleModels = hermesSettings.visibleModels;
    if (visibleModels.length === 0) {
      container.createEl('p', {
        text: 'No models configured. Start a Hermes session to discover models, or configure them in ~/.hermes/config.yaml.',
        cls: 'claudian-setting-description',
      });
    } else {
      const modelList = container.createEl('div', { cls: 'claudian-model-list' });
      for (const rawId of visibleModels) {
        const alias = hermesSettings.modelAliases[rawId];
        modelList.createEl('div', {
          text: alias ? `${rawId} → ${alias}` : rawId,
          cls: 'claudian-model-list-item',
        });
      }
    }

    new Setting(container).setName('Installation').setHeading();

    container.createEl('p', {
      text: 'Hermes Agent requires Python 3.11+. Install with:',
      cls: 'claudian-setting-description',
    });

    container.createEl('code', {
      text: 'pip install hermes-agent[acp]',
      cls: 'claudian-setting-code',
    });

    container.createEl('p', {
      text: 'Or use the one-line installer (Linux/macOS/WSL2):',
      cls: 'claudian-setting-description',
    });

    container.createEl('code', {
      text: 'curl -fsSL https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.sh | bash',
      cls: 'claudian-setting-code',
    });

    container.createEl('p', {
      text: 'After installation, configure a model provider with: hermes model',
      cls: 'claudian-setting-description',
    });
  },
};
