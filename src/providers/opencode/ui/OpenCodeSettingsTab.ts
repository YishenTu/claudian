import type { ProviderSettingsTabRenderer, ProviderSettingsTabRendererContext } from '../../../core/providers/types';

export const openCodeSettingsTabRenderer: ProviderSettingsTabRenderer = {
  render(container: HTMLElement, context: ProviderSettingsTabRendererContext) {
    const { plugin } = context;

    // OpenCode CLI Path Setting
    const cliPathDiv = container.createEl('div', { cls: 'setting-item' });
    cliPathDiv.createEl('h3', { text: 'OpenCode CLI Path' });
    cliPathDiv.createEl('p', {
      text: 'Leave blank to auto-detect from PATH. Set explicit path if auto-detection fails.',
      cls: 'setting-item-description',
    });

    const cliPathInput = cliPathDiv.createEl('input', {
      type: 'text',
      cls: 'text-input',
      placeholder: 'Auto-detect or enter path to opencode executable',
    });

    const settings = plugin.settings as unknown as Record<string, unknown>;
    cliPathInput.value = (settings['opencodeCliPath'] as string) || '';

    cliPathInput.addEventListener('change', async () => {
      settings['opencodeCliPath'] = cliPathInput.value;
      await plugin.saveSettings();
    });

    // Additional OpenCode settings can be added here
    const infoDiv = container.createEl('div', { cls: 'setting-item' });
    infoDiv.createEl('h3', { text: 'About OpenCode Integration' });
    infoDiv.createEl('p', {
      text: 'OpenCode is integrated via ACP (Agent Client Protocol). Make sure you have OpenCode installed and configured.',
      cls: 'setting-item-description',
    });

    const linkEl = infoDiv.createEl('a', {
      href: 'https://github.com/anomalyco/opencode',
      text: 'Learn more about OpenCode',
    });
    linkEl.target = '_blank';
  },
};
