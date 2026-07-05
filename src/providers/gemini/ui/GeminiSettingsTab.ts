import { Setting, Notice, requestUrl } from 'obsidian';

import type { ProviderSettingsTabRenderer, ProviderSettingsTabRendererContext } from '../../../core/providers/types';
import { getGeminiProviderSettings, updateGeminiProviderSettings } from '../settings';

export const geminiSettingsTabRenderer: ProviderSettingsTabRenderer = {
  render(container: HTMLElement, context: ProviderSettingsTabRendererContext): void {
    const { plugin } = context;
    const settings = plugin.settings as unknown as Record<string, unknown>;
    const providerSettings = getGeminiProviderSettings(settings);

    let currentApiKey = '';
    const envVars = providerSettings.environmentVariables;
    const keyMatch = envVars.match(/GEMINI_API_KEY=([^\n]*)/);
    if (keyMatch) {
      currentApiKey = keyMatch[1];
    }

    new Setting(container)
      .setName('Gemini API Key')
      .setDesc('API key for Google Gemini. You can also set this via the GEMINI_API_KEY environment variable.')
      .addText(text => {
        text.setPlaceholder('AIzaSy...');
        text.inputEl.type = 'password';

        if (currentApiKey) {
          text.setValue(currentApiKey);
        }

        text.onChange(async (value) => {
          currentApiKey = value;
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

    new Setting(container)
      .setName('Refresh available models')
      .setDesc('Fetch the latest models dynamically from the Google Generative AI API using your API key.')
      .addButton(button => {
        button.setButtonText('Refresh');
        button.onClick(async () => {
          if (!currentApiKey) {
            new Notice('Please enter an API key first.');
            return;
          }

          button.setButtonText('Refreshing...');
          button.setDisabled(true);

          try {
            const response = await requestUrl({
              url: `https://generativelanguage.googleapis.com/v1beta/models?key=${currentApiKey}`,
              method: 'GET',
            });

            if (response.status === 200) {
              const data = response.json;
              const models = data.models || [];
              const fetchedModels = models
                .filter((m: any) => m.supportedGenerationMethods?.includes('generateContent') && m.name.startsWith('models/'))
                .map((m: any) => {
                  const id = m.name.replace('models/', '');
                  return {
                    id,
                    label: m.displayName || id,
                  };
                });

              if (fetchedModels.length > 0) {
                // Keep the hardcoded models in visibleModels, but add the new ones to fetchedModels
                updateGeminiProviderSettings(settings, { fetchedModels });
                await plugin.saveSettings();
                new Notice(`Successfully fetched ${fetchedModels.length} models! Restart the plugin to see them.`);
              } else {
                new Notice('No supported models found.');
              }
            } else {
              new Notice(`Failed to fetch models: ${response.status}`);
            }
          } catch (e) {
            console.error('Failed to fetch Gemini models:', e);
            new Notice('Failed to fetch models. Check console for details.');
          } finally {
            button.setButtonText('Refresh');
            button.setDisabled(false);
          }
        });
      });
  },
};
