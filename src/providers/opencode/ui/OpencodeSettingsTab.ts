import { Setting } from 'obsidian';

import type { ProviderSettingsTabRenderer } from '../../../core/providers/types';
import { renderEnvironmentSettingsSection } from '../../../features/settings/ui/EnvironmentSettingsSection';
import { t } from '../../../i18n/i18n';
import { getOpencodeProviderSettings, updateOpencodeProviderSettings } from '../settings';

export const opencodeSettingsTabRenderer: ProviderSettingsTabRenderer = {
  render(container, context) {
    const settingsBag = context.plugin.settings as unknown as Record<string, unknown>;
    const opencodeSettings = getOpencodeProviderSettings(settingsBag);

    // --- Setup ---

    new Setting(container).setName(t('settings.setup')).setHeading();

    new Setting(container)
      .setName(t('settings.opencode.enabled.name'))
      .setDesc(t('settings.opencode.enabled.desc'))
      .addToggle((toggle) =>
        toggle
          .setValue(opencodeSettings.enabled)
          .onChange(async (value) => {
            updateOpencodeProviderSettings(settingsBag, { enabled: value });
            await context.plugin.saveSettings();
            context.refreshModelSelectors();
          })
      );

    new Setting(container)
      .setName(t('settings.opencode.prewarm.name'))
      .setDesc(t('settings.opencode.prewarm.desc'))
      .addToggle((toggle) =>
        toggle
          .setValue(opencodeSettings.prewarm ?? true)
          .onChange(async (value) => {
            updateOpencodeProviderSettings(settingsBag, { prewarm: value });
            await context.plugin.saveSettings();
          })
      );

    // --- CLI Path ---

    new Setting(container)
      .setName(t('settings.opencode.cliPath.name'))
      .setDesc(t('settings.opencode.cliPath.desc'))
      .addText((text) =>
        text
          .setPlaceholder(t('settings.opencode.cliPath.placeholder'))
          .setValue(opencodeSettings.cliPath || '')
          .onChange(async (value) => {
            updateOpencodeProviderSettings(settingsBag, { cliPath: value });
            await context.plugin.saveSettings();
          })
      );

    // --- MCP Servers ---

    new Setting(container).setName(t('settings.mcpServers.name')).setHeading();
    const mcpNotice = container.createDiv({ cls: 'claudian-mcp-settings-desc' });
    const mcpDesc = mcpNotice.createEl('p', { cls: 'setting-item-description' });
    mcpDesc.appendText(t('settings.opencode.mcpServers.desc') + ' ');
    mcpDesc.createEl('a', {
      text: 'Learn more',
      href: 'https://modelcontextprotocol.io',
    });

    // --- Environment ---

    renderEnvironmentSettingsSection({
      container,
      plugin: context.plugin,
      scope: 'provider:opencode',
      heading: t('settings.opencode.environment.name'),
      name: t('settings.opencode.environment.name'),
      desc: t('settings.opencode.environment.desc'),
      placeholder: t('settings.opencode.environment.placeholder'),
      renderCustomContextLimits: (target) => context.renderCustomContextLimits(target, 'opencode'),
    });
  },
};
