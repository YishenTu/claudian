import * as fs from 'fs';
import { Setting } from 'obsidian';

import { probeCLIInstallation } from '@/core/providers/cli/CLIInstallationProbe';
import type { ProviderVaultEntryRepository } from '@/core/providers/commands/ProviderVaultEntryRepository';
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
import { getHostnameKey } from '../../../utils/env';
import { normalizeConfiguredCLIPath } from '../../../utils/path';
import {
  getClaudeModelOptions,
} from '../modelOptions';
import {
  CLAUDE_SAFE_MODES,
  type ClaudeSafeMode,
  getClaudeProviderSettings,
  updateClaudeProviderSettings,
} from '../settings';
import { SlashCommandSettings } from './SlashCommandSettings';

export function createClaudeSettingsTabRenderer(
  claudeWorkspace: { cliResolver: Pick<ProviderCLIResolver, 'reset'>; vaultCommandRepository: ProviderVaultEntryRepository; modelCatalog: ProviderModelCatalog; },
): ProviderSettingsTabRenderer {
  return {
    render(container, context) {
      const settingsBag = context.plugin.settings as unknown as Record<string, unknown>;
      const claudeSettings = getClaudeProviderSettings(settingsBag);

      // --- Setup ---

      const enablement: Omit<ProviderEnablementSettingOptions, 'container' | 'description'> = {
        getValue: () => getClaudeProviderSettings(settingsBag).enabled,
        name: t('settings.providerEnablement.name', { provider: 'Claude' }),
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
        providerName: 'Claude',
      });

      const hostnameKey = getHostnameKey();
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
      const modelPicker = renderProviderModelsSection(container, 'claude', 'Claude', claudeWorkspace.modelCatalog, () => modelWarning.refresh());

      new Setting(container)
        .setName(t('settings.claude.responseStyle.name'))
        .setDesc(t('settings.claude.responseStyle.desc'))
        .addDropdown((dropdown) => {
          dropdown.selectEl.setAttribute('aria-label', t('settings.claude.responseStyle.name'));
          dropdown
            .addOption('Default', t('settings.claude.responseStyle.default'))
            .addOption('Concise', t('settings.claude.responseStyle.concise'))
            .setValue(claudeSettings.responseStyle)
            .onChange(async (value) => {
              await context.plugin.mutateSettings((settings) => {
                updateClaudeProviderSettings(settings, {
                  responseStyle: value === 'Concise' ? 'Concise' : 'Default',
                });
              });
            });
        });

      // --- Safety ---

      new Setting(container).setName(t('settings.safety')).setHeading();

      new Setting(container)
        .setName(t('settings.claudeSafeMode.name'))
        .setDesc(t('settings.claudeSafeMode.desc'))
        .addDropdown((dropdown) => {
          for (const mode of CLAUDE_SAFE_MODES) {
            dropdown.addOption(mode, mode);
          }
          dropdown
            .setValue(claudeSettings.safeMode)
            .onChange(async (value) => {
              await context.plugin.mutateSettings((settings) => {
                updateClaudeProviderSettings(
                  settings,
                  { safeMode: value as ClaudeSafeMode },
                );
              });
            });
        });

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

      // --- Slash Commands ---

      new Setting(container).setName(t('settings.slashCommands.name')).setHeading();

      const slashCommandsDesc = container.createDiv({ cls: 'claudian-sp-settings-desc' });
      const descP = slashCommandsDesc.createEl('p', { cls: 'setting-item-description' });
      descP.appendText(t('settings.slashCommands.desc') + ' ');
      descP.createEl('a', {
        text: 'Learn more',
        href: 'https://code.claude.com/docs/en/skills',
      });

      const slashCommandsContainer = container.createDiv({ cls: 'claudian-slash-commands-container' });
      new SlashCommandSettings(
        slashCommandsContainer,
        context.plugin.app,
        claudeWorkspace.vaultCommandRepository,
      );

      context.renderHiddenProviderCommandSetting(container, 'claude', {
        name: t('settings.hiddenSlashCommands.name'),
        desc: t('settings.hiddenSlashCommands.desc'),
        placeholder: t('settings.hiddenSlashCommands.placeholder'),
      });

      // --- Environment ---

      renderEnvironmentSettingsSection({
        container,
        plugin: context.plugin,
        scope: 'provider:claude',
        heading: t('settings.environment'),
        name: t('settings.customVariables.name'),
        desc: 'Claude-owned runtime variables only. Use this for ANTHROPIC_* and Claude-specific toggles.',
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
