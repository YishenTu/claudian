import { Setting } from 'obsidian';

import { ProviderSettingsCoordinator } from '../../../core/providers/ProviderSettingsCoordinator';
import type { ProviderSettingsTabRenderer } from '../../../core/providers/types';
import { renderEnvironmentSettingsSection } from '../../../features/settings/ui/EnvironmentSettingsSection';
import { t } from '../../../i18n/i18n';
import { parseConfiguredCustomGeminiModelIds, resolveGeminiModelSelection } from '../modelOptions';
import { getGeminiProviderSettings, updateGeminiProviderSettings } from '../settings';
import { DEFAULT_GEMINI_PRIMARY_MODEL } from '../types/models';

export const geminiSettingsTabRenderer: ProviderSettingsTabRenderer = {
  render(container, context) {
    const settingsBag = context.plugin.settings as unknown as Record<string, unknown>;
    const geminiSettings = getGeminiProviderSettings(settingsBag);

    const reconcileActiveGeminiModelSelection = (): void => {
      if (settingsBag.settingsProvider !== 'gemini') {
        return;
      }
      const currentModel = typeof settingsBag.model === 'string' ? settingsBag.model : '';
      const nextModel = resolveGeminiModelSelection(settingsBag, currentModel);
      if (nextModel && nextModel !== currentModel) {
        settingsBag.model = nextModel;
      }
    };

    new Setting(container).setName(t('settings.setup')).setHeading();

    new Setting(container)
      .setName('Enable Gemini provider')
      .setDesc('When enabled, Gemini API models appear in the model selector for new conversations.')
      .addToggle((toggle) =>
        toggle
          .setValue(geminiSettings.enabled)
          .onChange(async (value) => {
            updateGeminiProviderSettings(settingsBag, { enabled: value });
            await context.plugin.saveSettings();
            context.refreshModelSelectors();
          })
      );

    new Setting(container).setName(t('settings.models')).setHeading();

    new Setting(container)
      .setName('Custom models')
      .setDesc('Append additional Gemini model IDs to the picker, one per line. GEMINI_MODEL still takes precedence when set.')
      .addTextArea((text) => {
        let pendingCustomModels = geminiSettings.customModels;
        let savedCustomModels = geminiSettings.customModels;

        const reconcileInactiveGeminiProjection = (previousCustomModels: string): boolean => {
          if (settingsBag.settingsProvider === 'gemini') {
            return false;
          }

          const savedProviderModel = (
            settingsBag.savedProviderModel
            && typeof settingsBag.savedProviderModel === 'object'
          )
            ? settingsBag.savedProviderModel as Record<string, unknown>
            : {};
          const currentSavedModel = typeof savedProviderModel.gemini === 'string'
            ? savedProviderModel.gemini
            : '';
          if (!currentSavedModel) {
            return false;
          }

          const previousCustomModelIds = new Set(parseConfiguredCustomGeminiModelIds(previousCustomModels));
          if (!previousCustomModelIds.has(currentSavedModel)) {
            return false;
          }

          const nextSavedModel = resolveGeminiModelSelection(settingsBag, currentSavedModel);
          if (!nextSavedModel || nextSavedModel === currentSavedModel) {
            return false;
          }

          settingsBag.savedProviderModel = {
            ...savedProviderModel,
            gemini: nextSavedModel,
          };
          return true;
        };

        const commitCustomModels = async (): Promise<void> => {
          const previousCustomModels = savedCustomModels;
          const previousModel = typeof settingsBag.model === 'string' ? settingsBag.model : '';

          if (pendingCustomModels !== savedCustomModels) {
            updateGeminiProviderSettings(settingsBag, { customModels: pendingCustomModels });
            savedCustomModels = pendingCustomModels;
          }

          reconcileActiveGeminiModelSelection();
          const didReconcileInactiveProjection = reconcileInactiveGeminiProjection(previousCustomModels);
          const didReconcileTitleModel = ProviderSettingsCoordinator
            .reconcileTitleGenerationModelSelection(settingsBag);
          const nextModel = typeof settingsBag.model === 'string' ? settingsBag.model : '';

          if (
            previousCustomModels === savedCustomModels
            && previousModel === nextModel
            && !didReconcileInactiveProjection
            && !didReconcileTitleModel
          ) {
            return;
          }

          await context.plugin.saveSettings();
          context.refreshModelSelectors();
        };

        text
          .setPlaceholder('gemini-2.5-pro-preview\ngemini-3-pro-preview')
          .setValue(geminiSettings.customModels)
          .onChange((value) => {
            pendingCustomModels = value;
          });
        text.inputEl.rows = 4;
        text.inputEl.cols = 40;
        text.inputEl.addEventListener('blur', () => {
          void commitCustomModels();
        });
      });

    new Setting(container)
      .setName('Temperature')
      .setDesc('Gemini generation temperature for chat and auxiliary requests. Range: 0.0–2.0.')
      .addText((text) => {
        text
          .setPlaceholder('1.0')
          .setValue(String(geminiSettings.temperature))
          .onChange(async (value) => {
            const parsed = Number(value);
            if (!Number.isFinite(parsed)) return;
            updateGeminiProviderSettings(settingsBag, { temperature: parsed });
            await context.plugin.saveSettings();
          });
      });

    renderEnvironmentSettingsSection({
      container,
      plugin: context.plugin,
      scope: 'provider:gemini',
      heading: t('settings.environment'),
      name: 'Gemini environment',
      desc: 'Gemini API variables. Add a Gemini API key from Google AI Studio. GEMINI_MODEL can override the selected model.',
      placeholder: `GEMINI_API_KEY=your-key\nGEMINI_MODEL=${DEFAULT_GEMINI_PRIMARY_MODEL}\nGEMINI_API_BASE_URL=https://generativelanguage.googleapis.com/v1beta`,
      renderCustomContextLimits: (target) => context.renderCustomContextLimits(target, 'gemini'),
    });
  },
};
