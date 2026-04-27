import * as fs from 'fs';
import { Setting } from 'obsidian';

import type { ProviderSettingsTabRenderer } from '../../../core/providers/types';
import { renderEnvironmentSettingsSection } from '../../../features/settings/ui/EnvironmentSettingsSection';
import { t } from '../../../i18n/i18n';
import type { TranslationKey } from '../../../i18n/types';
import { getHostnameKey } from '../../../utils/env';
import { expandHomePath } from '../../../utils/path';
import { getCursorProviderSettings, updateCursorProviderSettings } from '../settings';

export const cursorSettingsTabRenderer: ProviderSettingsTabRenderer = {
  render(container, context) {
    const settingsBag = context.plugin.settings as unknown as Record<string, unknown>;
    const cursorSettings = getCursorProviderSettings(settingsBag);
    const hostnameKey = getHostnameKey();

    new Setting(container).setName(t('settings.setup')).setHeading();

    new Setting(container)
      .setName('Enable Cursor Agent provider')
      .setDesc(
        'When enabled, Cursor Agent appears as a provider. Requires the Cursor CLI (`agent`) and authentication (for example CURSOR_API_KEY). Headless mode uses --trust; review permission mode and sandbox settings carefully.',
      )
      .addToggle((toggle) =>
        toggle
          .setValue(cursorSettings.enabled)
          .onChange(async (value) => {
            updateCursorProviderSettings(settingsBag, { enabled: value });
            await context.plugin.saveSettings();
            context.refreshModelSelectors();
          })
      );

    const cliPathSetting = new Setting(container)
      .setName(`Cursor Agent CLI path (${hostnameKey})`)
      .setDesc('Path to the `agent` binary, or leave empty to search PATH.');

    const validationEl = container.createDiv({ cls: 'claudian-cli-path-validation' });
    validationEl.style.color = 'var(--text-error)';
    validationEl.style.fontSize = '0.85em';
    validationEl.style.marginTop = '-0.5em';
    validationEl.style.marginBottom = '0.5em';
    validationEl.style.display = 'none';

    const validatePath = (value: string): string | null => {
      const trimmed = value.trim();
      if (!trimmed) return null;

      const expandedPath = expandHomePath(trimmed);

      if (!fs.existsSync(expandedPath)) {
        return t('settings.cliPath.validation.notExist' as TranslationKey);
      }
      const stat = fs.statSync(expandedPath);
      if (!stat.isFile()) {
        return t('settings.cliPath.validation.isDirectory' as TranslationKey);
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

    const cliPathsByHost = { ...cursorSettings.cliPathsByHost };

    const persistCliPath = async (value: string, inputEl?: HTMLInputElement): Promise<boolean> => {
      const isValid = updateCliPathValidation(value, inputEl);
      if (!isValid) {
        return false;
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
      return true;
    };

    const currentValue = cursorSettings.cliPathsByHost[hostnameKey] || '';

    cliPathSetting.addText((text) => {
      text
        .setPlaceholder('agent')
        .setValue(currentValue)
        .onChange(async (value) => {
          await persistCliPath(value, text.inputEl);
        });
      text.inputEl.addClass('claudian-settings-cli-path-input');
      text.inputEl.style.width = '100%';

      updateCliPathValidation(currentValue, text.inputEl);
    });

    new Setting(container).setName(t('settings.safety')).setHeading();

    const safety = container.createDiv({ cls: 'setting-item-description' });
    safety.createEl('p', {
      text: 'Claudian maps toolbar permission mode to Cursor CLI flags: YOLO uses --force and sandbox disabled; Plan uses plan mode with sandbox enabled; Normal uses sandbox enabled without --force. All runs use --trust so the agent can complete non-interactively.',
    });

    renderEnvironmentSettingsSection({
      container,
      plugin: context.plugin,
      scope: 'provider:cursor',
      heading: t('settings.environment'),
      name: 'Cursor Agent environment',
      desc: 'Variables such as CURSOR_API_KEY. Chats are stored under ~/.cursor/chats/<workspace-hash>/<session-id>/.',
      placeholder: 'CURSOR_API_KEY=your-key',
      renderCustomContextLimits: (target) => context.renderCustomContextLimits(target, 'cursor'),
    });
  },
};
