import { type DropdownComponent } from 'obsidian';

import type { ProviderCLIResolver } from '@/core/providers/types';
import { CLAUDE_PROVIDER_ICON } from '@/shared/icons';
import { AccessibleSetting } from '@/shared/settings/AccessibleSetting';
import { renderCLIInstallationSetting } from '@/shared/settings/CLIInstallationSetting';
import { renderExecutionTargetSettings, validateExecutionTargetCLIPath } from '@/shared/settings/ExecutionTargetSettings';

import type { ProviderModelCatalog } from '../../../core/providers/models/ProviderModelCatalog';
import { ProviderSettingsCoordinator } from '../../../core/providers/ProviderSettingsCoordinator';
import type { ProviderSettingsTabRenderer } from '../../../core/providers/types';
import { t } from '../../../i18n/i18n';
import { renderEnvironmentSettingsSection } from '../../../shared/settings/EnvironmentSettingsSection';
import type { ProviderEnablementSettingOptions } from '../../../shared/settings/ProviderEnablementSetting';
import { renderLastEnabledProviderWarning, renderProviderModelEnablementWarning } from '../../../shared/settings/ProviderModelEnablementWarning';
import { renderProviderModelsSection } from '../../../shared/settings/ProviderModelsSection';
import {
  getClaudeModelOptions,
} from '../modelOptions';
import { inspectClaudeInstallation } from '../runtime/ClaudeCLIInstallation';
import {
  getClaudeModelSource,
  getClaudeProviderSettings,
  updateClaudeProviderSettings,
} from '../settings';

const INHERITED_OUTPUT_STYLE = '';

export function createClaudeSettingsTabRenderer(
  claudeWorkspace: { cliResolver: Pick<ProviderCLIResolver, 'reset'>; modelCatalog: ProviderModelCatalog; },
): ProviderSettingsTabRenderer {
  return {
    render(container, context) {
      const settingsBag = context.plugin.settings as unknown as Record<string, unknown>;
      const claudeSettings = getClaudeProviderSettings(settingsBag);

      // --- Setup ---

      const enablement: Omit<ProviderEnablementSettingOptions, 'container' | 'description'> = {
        getValue: () => getClaudeProviderSettings(settingsBag).enabled,
        name: t('settings.providerEnablement.name', { provider: 'Claude Code' }),
        onChange: async (value) => {
          if (!ProviderSettingsCoordinator.canApplyProviderEnablement(
            settingsBag,
            'claude',
            value,
          )) {
            lastProviderWarning.showFor();
            return;
          }

          let accepted = true;
          await context.plugin.runProviderExecutionTransition(['claude'], async () => {
            await context.plugin.mutateSettings((settings) => {
              accepted = ProviderSettingsCoordinator.applyProviderEnablement(
                settings,
                'claude',
                value,
              );
            });
          });
          if (accepted) {
            lastProviderWarning.hide();
          } else {
            lastProviderWarning.showFor();
          }
          modelWarning.context.notifyProviderModelOptionsChanged('claude');
        },
      };

      const installationContainer = container.createDiv({ cls: 'claudian-claude-installation' });
      const lastProviderWarning = renderLastEnabledProviderWarning(container);
      const modelWarning = renderProviderModelEnablementWarning(container, context, {
        getHasEnabledModels: () => getClaudeModelOptions(getClaudeModelSource(settingsBag)).length > 0,
        getIsEnabled: () => getClaudeProviderSettings(settingsBag).enabled,
        providerId: 'claude',
        providerName: 'Claude Code',
      });

      const hostnameKey = context.plugin.storage.installationKey;
      const getPlaceholder = () => process.platform === 'win32'
        ? (getClaudeProviderSettings(settingsBag).installationMethod === 'wsl'
          ? 'claude' : 'D:\\nodejs\\node_global\\node_modules\\@anthropic-ai\\claude-code\\cli-wrapper.cjs')
        : '/usr/local/lib/node_modules/@anthropic-ai/claude-code/cli-wrapper.cjs';
      const cliPathControl = renderCLIInstallationSetting({
        cliName: 'Claude Code',
        icon: CLAUDE_PROVIDER_ICON,
        inspect: () => inspectClaudeInstallation(context.plugin.getRuntimeHost('claude')),
        container: installationContainer,
        enablement,
        getValue: () => {
          const config = getClaudeProviderSettings(settingsBag);
          return config.cliPathsByHost[hostnameKey] || config.cliPath;
        },
        name: t('settings.cliPath.name'),
        onChange: async (value) => {
          const cliPathsByHost = {
            ...getClaudeProviderSettings(settingsBag).cliPathsByHost,
          };
          if (value) {
            cliPathsByHost[hostnameKey] = value;
          } else {
            delete cliPathsByHost[hostnameKey];
          }

          await context.plugin.applyProviderRuntimeSettings(
            ['claude'],
            (settings) => {
              updateClaudeProviderSettings(settings, { cliPathsByHost, cliPath: '' });
            },
            async () => {
              claudeWorkspace.cliResolver.reset();
            },
          );
        },
        placeholder: getPlaceholder(),
        validate: value => validateExecutionTargetCLIPath(value, getClaudeProviderSettings(settingsBag)),
      });
      renderExecutionTargetSettings({
        container, providerName: 'Claude Code',
        getValue: () => getClaudeProviderSettings(settingsBag),
        onChange: async updates => {
          await context.plugin.applyProviderRuntimeSettings(
            ['claude'],
            settings => { updateClaudeProviderSettings(settings, updates); },
            () => claudeWorkspace.cliResolver.reset(),
          );
        },
        onRefresh: () => {
          cliPathControl.setPlaceholder(getPlaceholder());
          cliPathControl.revalidate();
          void cliPathControl.refresh();
        },
      });

      // --- Models ---

      new AccessibleSetting(container).setName(t('settings.models')).setHeading();
      let outputStyleDropdown: DropdownComponent | null = null;
      // Rebuilt whenever discovery reports a new list, keeping a saved style the list lacks selectable.
      const renderOutputStyleOptions = (): void => {
        if (!outputStyleDropdown) return;
        const { outputStyle, discoveredOutputStyles } = getClaudeProviderSettings(settingsBag);
        const names = outputStyle && !discoveredOutputStyles.includes(outputStyle)
          ? [...discoveredOutputStyles, outputStyle]
          : discoveredOutputStyles;
        outputStyleDropdown.selectEl.replaceChildren();
        outputStyleDropdown.addOption(INHERITED_OUTPUT_STYLE, t('settings.claude.responseStyle.inherit'));
        for (const name of names) {
          outputStyleDropdown.addOption(name, name === 'default' ? t('settings.claude.responseStyle.default') : name);
        }
        outputStyleDropdown.setValue(outputStyle ?? INHERITED_OUTPUT_STYLE);
      };

      const modelPicker = renderProviderModelsSection(container, 'claude', 'Claude Code', claudeWorkspace.modelCatalog, () => {
        modelWarning.refresh();
        renderOutputStyleOptions();
      });

      // --- Responses ---

      new AccessibleSetting(container).setName(t('settings.responses')).setHeading();

      new AccessibleSetting(container)
        .setName(t('settings.claude.promptSuggestions.name'))
        .setDesc(t('settings.claude.promptSuggestions.desc'))
        .addToggle(toggle => toggle
          .setValue(claudeSettings.promptSuggestions)
          .onChange(async value => {
            await context.plugin.mutateSettings(settings => {
              updateClaudeProviderSettings(settings, { promptSuggestions: value });
            });
          }));

      new AccessibleSetting(container)
        .setName(t('settings.claude.responseStyle.name'))
        .setDesc(t('settings.claude.responseStyle.desc'))
        .addDropdown((dropdown) => {
          outputStyleDropdown = dropdown;
          dropdown.selectEl.setAttribute('aria-label', t('settings.claude.responseStyle.name'));
          renderOutputStyleOptions();
          dropdown.onChange(async (value) => {
            await context.plugin.mutateSettings((settings) => {
              updateClaudeProviderSettings(settings, { outputStyle: value || null });
            });
          });
        });

      // --- Configuration ---

      new AccessibleSetting(container).setName(t('settings.claude.configuration')).setHeading();

      new AccessibleSetting(container)
        .setName(t('settings.loadUserSettings.name'))
        .setDesc(t('settings.loadUserSettings.desc'))
        .addToggle((toggle) =>
          toggle
            .setValue(claudeSettings.loadUserSettings)
            .onChange(async (value) => {
              await context.plugin.applyProviderRuntimeSettings(['claude'], settings => {
                updateClaudeProviderSettings(settings, { loadUserSettings: value });
              });
            })
        );

      // --- Environment ---

      renderEnvironmentSettingsSection({
        container,
        plugin: context.plugin,
        scope: 'provider:claude',
        heading: t('settings.environment'),
        name: t('settings.customVariables.name'),
        desc: t('settings.customVariables.desc'),
        placeholder: 'ANTHROPIC_API_KEY=your-key\nANTHROPIC_BASE_URL=https://api.example.com\nANTHROPIC_MODEL=custom-model\nCLAUDE_CODE_USE_BEDROCK=1',
        renderCustomContextLimits: (target) => context.renderCustomContextLimits(target, 'claude'),
      });

      // --- Experimental ---

      new AccessibleSetting(container).setName(t('settings.experimental')).setHeading();

      new AccessibleSetting(container)
        .setName(t('settings.enableChrome.name'))
        .setDesc(t('settings.enableChrome.desc'))
        .addToggle((toggle) =>
          toggle
            .setValue(claudeSettings.enableChrome)
            .onChange(async (value) => {
              await context.plugin.mutateSettings((settings) => {
                updateClaudeProviderSettings(settings, { enableChrome: value });
              });
            })
        );

      return modelPicker;
    },
  };
}
