import { Setting } from 'obsidian';

import type { ProviderSettingsTabRenderer } from '../../../core/providers/types';
import { t } from '../../../i18n/i18n';
import { getCursorProviderSettings, updateCursorProviderSettings } from '../settings';

/**
 * Phase 1 placeholder: only the enable toggle is wired up. Full Setup, Models,
 * and Environment sections are added in Phase 4 once the runtime is real.
 */
export const cursorSettingsTabRenderer: ProviderSettingsTabRenderer = {
  render(container, context) {
    const settingsBag = context.plugin.settings as unknown as Record<string, unknown>;
    const cursorSettings = getCursorProviderSettings(settingsBag);

    new Setting(container).setName(t('settings.setup')).setHeading();

    new Setting(container)
      .setName('Enable Cursor provider')
      .setDesc('When enabled, Cursor models appear in the model selector for new conversations. The runtime is currently under development.')
      .addToggle(toggle =>
        toggle
          .setValue(cursorSettings.enabled)
          .onChange(async (value) => {
            updateCursorProviderSettings(settingsBag, { enabled: value });
            await context.plugin.saveSettings();
            context.refreshModelSelectors();
          }),
      );

    container.createEl('p', {
      cls: 'claudian-settings-cursor-placeholder',
      text: 'The Cursor CLI runtime, settings, and auxiliary services are landing in upcoming phases.',
    });
  },
};
