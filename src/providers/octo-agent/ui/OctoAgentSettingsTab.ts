import { Setting } from 'obsidian';

import type { ProviderSettingsTabRenderer } from '../../../core/providers/types';
import { renderEnvironmentSettingsSection } from '../../../features/settings/ui/EnvironmentSettingsSection';
import {
  getOctoAgentProviderSettings,
  updateOctoAgentProviderSettings,
} from '../settings';

export const octoAgentSettingsTabRenderer: ProviderSettingsTabRenderer = {
  render(container, context) {
    const settingsBag = context.plugin.settings as unknown as Record<string, unknown>;
    const settings = getOctoAgentProviderSettings(settingsBag);

    new Setting(container).setName('Setup').setHeading();

    new Setting(container)
      .setName('Enable octo agent')
      .setDesc('Connect to a local octo-agent server as a provider.')
      .addToggle((toggle) =>
        toggle
          .setValue(settings.enabled)
          .onChange(async (value) => {
            updateOctoAgentProviderSettings(settingsBag, { enabled: value });
            await context.plugin.saveSettings();
            context.refreshModelSelectors();
          })
      );

    new Setting(container)
      .setName('Host')
      .setDesc('Hostname of the octo-agent server.')
      .addText((text) =>
        text
          .setPlaceholder('127.0.0.1')
          .setValue(settings.host)
          .onChange(async (value) => {
            updateOctoAgentProviderSettings(settingsBag, {
              host: value.trim() || '127.0.0.1',
            });
            await context.plugin.saveSettings();
          })
      );

    new Setting(container)
      .setName('Port')
      .setDesc('Port of the octo-agent server.')
      .addText((text) => {
        text
          .setPlaceholder('8088')
          .setValue(String(settings.port))
          .onChange(async (value) => {
            const parsed = Number.parseInt(value.trim(), 10);
            updateOctoAgentProviderSettings(settingsBag, {
              port: Number.isNaN(parsed) ? 8088 : parsed,
            });
            await context.plugin.saveSettings();
          });
      });

    new Setting(container)
      .setName('Auto-start server')
      .setDesc('Run `octo serve` automatically when Claudian needs a connection.')
      .addToggle((toggle) =>
        toggle
          .setValue(settings.autoStartServer)
          .onChange(async (value) => {
            updateOctoAgentProviderSettings(settingsBag, { autoStartServer: value });
            await context.plugin.saveSettings();
          })
      );

    new Setting(container)
      .setName('CLI path')
      .setDesc('Command used to start the octo-agent server. Leave empty to use `octo` from PATH.')
      .addText((text) =>
        text
          .setPlaceholder('/usr/local/bin/octo')
          .setValue(settings.cliPath)
          .onChange(async (value) => {
            updateOctoAgentProviderSettings(settingsBag, {
              cliPath: value.trim() || 'octo',
            });
            await context.plugin.saveSettings();
          })
      );

    new Setting(container)
      .setName('Access key')
      .setDesc('Optional access key for non-loopback hosts. Leave empty when using 127.0.0.1.')
      .addText((text) =>
        text
          .setPlaceholder('Octo_...')
          .setValue(settings.accessKey)
          .onChange(async (value) => {
            updateOctoAgentProviderSettings(settingsBag, { accessKey: value.trim() });
            await context.plugin.saveSettings();
          })
      );

    renderEnvironmentSettingsSection({
      container,
      desc: 'Environment variables passed only to the octo-agent server process.',
      heading: 'Environment',
      name: 'Octo Agent environment variables',
      placeholder: 'OCTO_MODEL=claude-sonnet-4',
      plugin: context.plugin,
      scope: 'provider:octo-agent',
    });
  },
};
