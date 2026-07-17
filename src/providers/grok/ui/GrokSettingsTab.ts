import * as fs from 'fs';
import { Setting } from 'obsidian';

import { ProviderSettingsCoordinator } from '../../../core/providers/ProviderSettingsCoordinator';
import type {
  ProviderSettingsTabRenderer,
} from '../../../core/providers/types';
import { renderEnvironmentSettingsSection } from '../../../shared/settings/EnvironmentSettingsSection';
import { getHostnameKey } from '../../../utils/env';
import { expandHomePath } from '../../../utils/path';
import { maybeGetGrokWorkspaceServices } from '../app/GrokWorkspaceServices';
import {
  getGrokProviderSettings,
  type GrokSafeMode,
  updateGrokProviderSettings,
} from '../settings';

export const grokSettingsTabRenderer: ProviderSettingsTabRenderer = {
  render(container, context) {
    const settingsBag = context.plugin.settings as unknown as Record<string, unknown>;
    const grokSettings = getGrokProviderSettings(settingsBag);
    const hostnameKey = getHostnameKey();
    const workspace = maybeGetGrokWorkspaceServices();

    new Setting(container).setName('Setup').setHeading();

    new Setting(container)
      .setName('Enable Grok provider')
      .setDesc(
        'When enabled, Grok Build appears in the model selector for new conversations. Prompts, selected context, and tool outputs may be sent to xAI according to your Grok configuration. Existing Grok sessions are preserved.',
      )
      .addToggle((toggle) =>
        toggle
          .setValue(grokSettings.enabled)
          .onChange(async (value) => {
            await context.plugin.mutateSettings((settings) => {
              ProviderSettingsCoordinator.applyProviderEnablement(settings, 'grok', value);
            });
            context.refreshModelSelectors();
            context.refreshTitleGenerationModelOptions();
          }),
      );

    const cliPathSetting = new Setting(container)
      .setName(`Grok CLI path (${hostnameKey})`)
      .setDesc(
        'Custom path to the local Grok Build CLI. Leave empty for auto-detection from PATH, ~/.grok/bin, and ~/.local/bin.',
      );

    const validationEl = container.createDiv({
      cls: 'claudian-cli-path-validation claudian-setting-validation claudian-setting-validation-error claudian-hidden',
    });
    const cliPathsByHost = { ...grokSettings.cliPathsByHost };
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

    const recycleGrokRuntime = async (): Promise<void> => {
      await context.plugin.recycleProviderRuntimes?.('grok');
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
        updateGrokProviderSettings(settings, { cliPathsByHost: { ...cliPathsByHost } });
      });
      workspace?.cliResolver?.reset();
      await recycleGrokRuntime();
      return true;
    };

    const currentValue = grokSettings.cliPathsByHost[hostnameKey] || '';
    cliPathSetting.addText((text) => {
      text
        .setPlaceholder(process.platform === 'win32'
          ? 'C:\\Users\\you\\.grok\\bin\\grok.exe'
          : '~/.grok/bin/grok')
        .setValue(currentValue)
        .onChange(async (value) => {
          await persistCliPath(value);
        });
      text.inputEl.addClass('claudian-settings-cli-path-input');
      cliPathInputEl = text.inputEl;
      updateCliPathValidation(currentValue, text.inputEl);
    });

    new Setting(container).setName('Safety').setHeading();
    new Setting(container)
      .setName('Grok sandbox')
      .setDesc(
        'Sandbox profile for Grok agent tools (GROK_SANDBOX). Profiles: workspace (read everywhere, write CWD/temp/~/.grok) and read-only. This does not create a stronger Claudian or OS filesystem boundary for ACP client file access. YOLO mode uses Grok\'s always-approve flag instead.',
      )
      .addDropdown((dropdown) => {
        dropdown
          .addOption('workspace', 'Workspace')
          .addOption('read-only', 'Read only')
          .setValue(grokSettings.safeMode)
          .onChange(async (value) => {
            await context.plugin.mutateSettings((settings) => {
              updateGrokProviderSettings(settings, {
                safeMode: value as GrokSafeMode,
              });
            });
            // GROK_SANDBOX is process launch env; recycle so the new profile applies.
            await recycleGrokRuntime();
          });
      });

    renderEnvironmentSettingsSection({
      container,
      plugin: context.plugin,
      scope: 'provider:grok',
      heading: 'Environment',
      name: 'Grok environment',
      desc: 'Grok-owned runtime variables only. Use this for GROK_* and XAI_* settings. If Grok auto-detection needs help, add its install directory to shared PATH instead of this provider section.',
      placeholder: 'GROK_DEPLOYMENT_KEY=your-key\nXAI_API_KEY=your-key\nGROK_MODEL=grok-4.5',
      renderCustomContextLimits: (target) => context.renderCustomContextLimits(target, 'grok'),
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
    const stat = fs.statSync(expandedPath);
    if (!stat.isFile()) {
      return 'Path is a directory, not a file';
    }
  } catch {
    return 'Path does not exist';
  }
  return null;
}
