import * as fs from 'fs';
import { Setting } from 'obsidian';

import type { ProviderSettingsTabRenderer } from '../../../core/providers/types';
import { renderEnvironmentSettingsSection } from '../../../features/settings/ui/EnvironmentSettingsSection';
import { t } from '../../../i18n/i18n';
import { getHostnameKey } from '../../../utils/env';
import { expandHomePath } from '../../../utils/path';
import { resolveCursorModelSelection } from '../modelOptions';
import { getCursorProviderSettings, updateCursorProviderSettings } from '../settings';
import { DEFAULT_CURSOR_PRIMARY_MODEL } from '../types/models';

export const cursorSettingsTabRenderer: ProviderSettingsTabRenderer = {
  render(container, context) {
    const settingsBag = context.plugin.settings as unknown as Record<string, unknown>;
    const cursorSettings = getCursorProviderSettings(settingsBag);
    const hostnameKey = getHostnameKey();
    const cliPathsByHost = { ...cursorSettings.cliPathsByHost };

    const reconcileActiveCursorModelSelection = (): void => {
      const activeProvider = settingsBag.settingsProvider;
      if (activeProvider !== 'cursor') {
        return;
      }
      const currentModel = typeof settingsBag.model === 'string' ? settingsBag.model : '';
      const nextModel = resolveCursorModelSelection(settingsBag, currentModel);
      if (!nextModel || nextModel === currentModel) {
        return;
      }
      settingsBag.model = nextModel;
    };

    // --- Setup ---

    new Setting(container).setName(t('settings.setup')).setHeading();

    new Setting(container)
      .setName('Enable Cursor provider')
      .setDesc('When enabled, Cursor models appear in the model selector for new conversations. Existing Cursor sessions are preserved.')
      .addToggle(toggle =>
        toggle
          .setValue(cursorSettings.enabled)
          .onChange(async (value) => {
            updateCursorProviderSettings(settingsBag, { enabled: value });
            await context.plugin.saveSettings();
            context.refreshModelSelectors();
          }),
      );

    const cliPathSetting = new Setting(container)
      .setName(`Cursor agent CLI path (${hostnameKey})`)
      .setDesc('Custom path to the local cursor-agent CLI. Leave empty for auto-detection from PATH.');

    const validationEl = container.createDiv({
      cls: 'claudian-cli-path-validation claudian-setting-validation claudian-setting-validation-error claudian-hidden',
    });

    const validatePath = (value: string): string | null => {
      const trimmed = value.trim();
      if (!trimmed) return null;

      const expandedPath = expandHomePath(trimmed);
      if (!fs.existsSync(expandedPath)) {
        return t('settings.cliPath.validation.notExist');
      }
      if (!fs.statSync(expandedPath).isFile()) {
        return t('settings.cliPath.validation.isDirectory');
      }
      return null;
    };

    let cliPathInputEl: HTMLInputElement | null = null;

    const updateCliPathValidation = (value: string): boolean => {
      const error = validatePath(value);
      if (error) {
        validationEl.setText(error);
        validationEl.toggleClass('claudian-hidden', false);
        cliPathInputEl?.toggleClass('claudian-input-error', true);
        return false;
      }
      validationEl.toggleClass('claudian-hidden', true);
      cliPathInputEl?.toggleClass('claudian-input-error', false);
      return true;
    };

    const persistCliPath = async (value: string): Promise<void> => {
      const isValid = updateCliPathValidation(value);
      if (!isValid) {
        return;
      }

      const trimmed = value.trim();
      if (trimmed) {
        cliPathsByHost[hostnameKey] = trimmed;
      } else {
        delete cliPathsByHost[hostnameKey];
      }

      updateCursorProviderSettings(settingsBag, { cliPathsByHost: { ...cliPathsByHost } });
      await context.plugin.saveSettings();
      const view = context.plugin.getView();
      await view?.getTabManager()?.broadcastToAllTabs(
        (service) => Promise.resolve(service.cleanup()),
      );
    };

    const currentCliValue = cursorSettings.cliPathsByHost[hostnameKey] || '';

    cliPathSetting.addText((text) => {
      text
        .setPlaceholder('/usr/local/bin/cursor-agent')
        .setValue(currentCliValue)
        .onChange(async (value) => {
          await persistCliPath(value);
        });
      text.inputEl.addClass('claudian-settings-cli-path-input');
      cliPathInputEl = text.inputEl;
      updateCliPathValidation(currentCliValue);
    });

    // --- Models ---

    new Setting(container).setName(t('settings.models')).setHeading();

    new Setting(container)
      .setName('Custom models')
      .setDesc('Append additional Cursor model ids to the picker, one per line. `CURSOR_MODEL` still takes precedence when set.')
      .addTextArea((text) => {
        let pendingCustomModels = cursorSettings.customModels;
        let savedCustomModels = cursorSettings.customModels;

        text
          .setValue(cursorSettings.customModels)
          .setPlaceholder('composer-2-fast\nclaude-haiku-4')
          .onChange((value) => {
            pendingCustomModels = value;
          });

        text.inputEl.rows = 4;
        text.inputEl.addClass('claudian-settings-custom-models-textarea');
        text.inputEl.addEventListener('blur', () => {
          if (pendingCustomModels === savedCustomModels) {
            return;
          }
          updateCursorProviderSettings(settingsBag, { customModels: pendingCustomModels });
          savedCustomModels = pendingCustomModels;
          reconcileActiveCursorModelSelection();
          void context.plugin.saveSettings().then(() => {
            context.refreshModelSelectors();
          });
        });
      });

    // --- Environment ---

    renderEnvironmentSettingsSection({
      container,
      plugin: context.plugin,
      scope: 'provider:cursor',
      heading: t('settings.environment'),
      name: 'Cursor environment',
      desc: 'Cursor-owned runtime variables only. Set CURSOR_API_KEY here. If cursor-agent auto-detection needs help, add its install directory to shared PATH instead of this provider section.',
      placeholder: `CURSOR_API_KEY=your-key\nCURSOR_MODEL=${DEFAULT_CURSOR_PRIMARY_MODEL}`,
      renderCustomContextLimits: (target) => context.renderCustomContextLimits(target, 'cursor'),
    });
  },
};
