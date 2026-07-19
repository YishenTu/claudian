import * as fs from 'fs';
import { Setting } from 'obsidian';

import { ProviderSettingsCoordinator } from '../../../core/providers/ProviderSettingsCoordinator';
import type {
  ProviderSettingsTabRenderer,
} from '../../../core/providers/types';
import { renderEnvironmentSettingsSection } from '../../../shared/settings/EnvironmentSettingsSection';
import { getHostnameKey } from '../../../utils/env';
import { expandHomePath } from '../../../utils/path';
import { maybeGetKimiWorkspaceServices } from '../app/KimiWorkspaceServices';
import {
  getKimiProviderSettings,
  updateKimiProviderSettings,
} from '../settings';

export const kimiSettingsTabRenderer: ProviderSettingsTabRenderer = {
  render(container, context) {
    const settingsBag = context.plugin.settings as unknown as Record<string, unknown>;
    const kimiSettings = getKimiProviderSettings(settingsBag);
    const hostnameKey = getHostnameKey();
    const workspace = maybeGetKimiWorkspaceServices();

    new Setting(container).setName('Setup').setHeading();

    new Setting(container)
      // Product name casing matches other providers (e.g. OpenCode).
      // eslint-disable-next-line obsidianmd/ui/sentence-case -- brand name
      .setName('Enable Kimi Code')
      .setDesc(
        'When enabled, Kimi Code appears in the model selector for new conversations. '
        + 'Prompts, selected context, and tool outputs may be sent according to your Kimi configuration. '
        + 'Requires Kimi Code CLI >= 0.27.0 (`kimi acp`). Existing Kimi sessions are preserved.',
      )
      .addToggle((toggle) =>
        toggle
          .setValue(kimiSettings.enabled)
          .onChange(async (value) => {
            await context.plugin.mutateSettings((settings) => {
              ProviderSettingsCoordinator.applyProviderEnablement(settings, 'kimi', value);
            });
            context.refreshModelSelectors();
            context.refreshTitleGenerationModelOptions();
          }),
      );

    new Setting(container)
      .setName('Authentication')
      .setDesc(
        'Kimi Code uses terminal device-code login. Claudian does not store Kimi credentials. '
        + 'Run `kimi login` in a terminal if session creation reports Authentication required (-32000). '
        + 'Do not edit `~/.kimi-code/config.toml` or credential files from Claudian.',
      );

    const cliPathSetting = new Setting(container)
      .setName(`Kimi CLI path (${hostnameKey})`)
      .setDesc(
        'Custom path to the local Kimi Code CLI (`kimi` / `kimi.exe` / `kimi.cmd`). '
        + 'Leave empty for auto-detection from PATH and common install dirs.',
      );

    const validationEl = container.createDiv({
      cls: 'claudian-cli-path-validation claudian-setting-validation claudian-setting-validation-error claudian-hidden',
    });
    const cliPathsByHost = { ...kimiSettings.cliPathsByHost };
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

    const recycleKimiRuntime = async (): Promise<void> => {
      await context.plugin.recycleProviderRuntimes?.('kimi');
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
      });
      workspace?.cliResolver?.reset();
      await recycleKimiRuntime();
      return true;
    };

    const currentValue = kimiSettings.cliPathsByHost[hostnameKey] || '';
    cliPathSetting.addText((text) => {
      text
        .setPlaceholder(process.platform === 'win32'
          ? 'C:\\Users\\you\\AppData\\Local\\kimi\\kimi.cmd'
          : '~/.local/bin/kimi')
        .setValue(currentValue)
        .onChange(async (value) => {
          await persistCliPath(value);
        });
      text.inputEl.addClass('claudian-settings-cli-path-input');
      cliPathInputEl = text.inputEl;
      updateCliPathValidation(currentValue, text.inputEl);
    });

    renderEnvironmentSettingsSection({
      container,
      plugin: context.plugin,
      scope: 'provider:kimi',
      heading: 'Environment',
      name: 'Kimi environment',
      desc: 'Kimi-owned runtime variables only (for example KIMI_CODE_HOME). '
        + 'Never put credentials here that you would not store in plain text. '
        + 'If auto-detection needs help, add the install directory to shared PATH instead.',
      placeholder: 'KIMI_CODE_HOME=/path/to/kimi-home',
      renderCustomContextLimits: (target) => context.renderCustomContextLimits(target, 'kimi'),
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
  try {
    if (!fs.statSync(expandedPath).isFile()) {
      return 'Path is not a file';
    }
  } catch {
    return 'Path is not accessible';
  }
  return null;
}
