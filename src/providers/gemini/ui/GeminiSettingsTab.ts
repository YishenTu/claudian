import { Setting } from 'obsidian';

import type { ProviderSettingsTabRenderer, ProviderSettingsTabRendererContext } from '../../../core/providers/types';
import { getGeminiProviderSettings, updateGeminiProviderSettings } from '../settings';

export const geminiSettingsTabRenderer: ProviderSettingsTabRenderer = {
  render(container: HTMLElement, context: ProviderSettingsTabRendererContext): void {
    const { plugin } = context;
    const settings = plugin.settings as unknown as Record<string, unknown>;
    const providerSettings = getGeminiProviderSettings(settings);

    new Setting(container)
      .setName('Gemini API Key')
      .setDesc('API key for Google Gemini. You can also set this via the GEMINI_API_KEY environment variable.')
      .addText(text => {
        text.setPlaceholder('AIzaSy...');
        text.inputEl.type = 'password';

        // Read from environmentVariables string
        const envVars = providerSettings.environmentVariables;
        const keyMatch = envVars.match(/GEMINI_API_KEY=([^\n]*)/);
        if (keyMatch) {
          text.setValue(keyMatch[1]);
        }

        text.onChange(async (value) => {
          let updatedEnvVars = providerSettings.environmentVariables;
          if (updatedEnvVars.includes('GEMINI_API_KEY=')) {
            updatedEnvVars = updatedEnvVars.replace(/GEMINI_API_KEY=[^\n]*/, `GEMINI_API_KEY=${value}`);
          } else {
            updatedEnvVars = updatedEnvVars ? `${updatedEnvVars}\nGEMINI_API_KEY=${value}` : `GEMINI_API_KEY=${value}`;
          }

          updateGeminiProviderSettings(settings, { environmentVariables: updatedEnvVars });
          await plugin.saveSettings();
        });
      });
  },
};
