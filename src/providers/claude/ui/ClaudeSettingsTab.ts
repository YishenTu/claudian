import * as fs from 'fs';
import { type DropdownComponent, Setting } from 'obsidian';

import { normalizeConfiguredCLIPath } from '@/core/process/cliPath';
import { probeCLIInstallation } from '@/core/providers/cli/CLIInstallationProbe';
import { getRuntimeEnvironmentVariables } from '@/core/providers/providerEnvironment';
import type { ProviderCLIResolver } from '@/core/providers/types';
import { CLAUDE_PROVIDER_ICON } from '@/shared/icons';
import { renderCLIInstallationSetting } from '@/shared/settings/CLIInstallationSetting';

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
import {
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
        getHasEnabledModels: () => getClaudeModelOptions(settingsBag).length > 0,
        getIsEnabled: () => getClaudeProviderSettings(settingsBag).enabled,
        providerId: 'claude',
        providerName: 'Claude Code',
      });

      const hostnameKey = context.plugin.storage.installationKey;
      const validatePath = (value: string): string | null => {
        const trimmed = value.trim();
        if (!trimmed) return null;

        const expandedPath = normalizeConfiguredCLIPath(trimmed);

        if (!fs.existsSync(expandedPath)) {
          return t('settings.cliPath.validation.notExist');
        }
        const stat = fs.statSync(expandedPath);
        if (!stat.isFile()) {
          return t('settings.cliPath.validation.isDirectory');
        }
        return null;
      };

      renderCLIInstallationSetting({
        cliName: 'Claude Code',
        icon: CLAUDE_PROVIDER_ICON,
        inspect: async () => {
          const settings = context.plugin.settings as unknown as Record<string, unknown>;
          const config = getClaudeProviderSettings(settings);
          return probeCLIInstallation({
            path: await context.plugin.getResolvedProviderCliPath('claude'),
            configuredPath: config.cliPathsByHost[hostnameKey] || config.cliPath,
            args: ['--version'],
            env: { ...process.env, ...getRuntimeEnvironmentVariables(settings, 'claude') },
          });
        },
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
        placeholder: process.platform === 'win32'
          ? 'D:\\nodejs\\node_global\\node_modules\\@anthropic-ai\\claude-code\\cli-wrapper.cjs'
          : '/usr/local/lib/node_modules/@anthropic-ai/claude-code/cli-wrapper.cjs',
        validate: validatePath,
      });

      // --- Models ---

      new Setting(container).setName(t('settings.models')).setHeading();
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

      new Setting(container).setName(t('settings.responses')).setHeading();

      new Setting(container)
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

      new Setting(container).setName(t('settings.claude.configuration')).setHeading();

      new Setting(container)
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

      new Setting(container).setName(t('settings.experimental')).setHeading();

      new Setting(container)
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
