import * as fs from 'fs';
import { Setting } from 'obsidian';

import { probeCliInstallation } from '@/core/providers/cli/CliInstallationProbe';
import { getRuntimeEnvironmentVariables } from '@/core/providers/providerEnvironment';
import { CLAUDE_PROVIDER_ICON } from '@/shared/icons';
import { renderCliInstallationSetting } from '@/shared/settings/CliInstallationSetting';

import { ProviderSettingsCoordinator } from '../../../core/providers/ProviderSettingsCoordinator';
import type { ProviderSettingsTabRenderer } from '../../../core/providers/types';
import { t } from '../../../i18n/i18n';
import { renderEnvironmentSettingsSection } from '../../../shared/settings/EnvironmentSettingsSection';
import type { ProviderEnablementSettingOptions } from '../../../shared/settings/ProviderEnablementSetting';
import { renderLastEnabledProviderWarning } from '../../../shared/settings/ProviderModelEnablementWarning';
import { getHostnameKey } from '../../../utils/env';
import { normalizeConfiguredCliPath } from '../../../utils/path';
import { getClaudeWorkspaceServices } from '../app/ClaudeWorkspaceServices';
import {
  getClaudeModelOptions,
  resolveClaudeModelEnvironmentTypePreference,
  resolveClaudeModelSelection,
} from '../modelOptions';
import {
  CLAUDE_SAFE_MODES,
  type ClaudeSafeMode,
  getClaudeProviderSettings,
  updateClaudeProviderSettings,
} from '../settings';
import { AgentSettings } from './AgentSettings';
import { claudeChatUIConfig } from './ClaudeChatUIConfig';
import { PluginSettingsManager } from './PluginSettingsManager';
import { SlashCommandSettings } from './SlashCommandSettings';

export const claudeSettingsTabRenderer: ProviderSettingsTabRenderer = {
  render(container, context) {
    const claudeWorkspace = getClaudeWorkspaceServices();
    const settingsBag = context.plugin.settings as unknown as Record<string, unknown>;
    const claudeSettings = getClaudeProviderSettings(settingsBag);

    const reconcileActiveClaudeModelSelection = (settings: Record<string, unknown>): void => {
      const activeProvider = settings.settingsProvider;
      if (activeProvider !== undefined && activeProvider !== 'claude') {
        return;
      }

      const currentModel = typeof settings.model === 'string' ? settings.model : '';
      const nextModel = resolveClaudeModelSelection(settings, currentModel);
      if (!nextModel || nextModel === currentModel) {
        return;
      }

      settings.model = nextModel;
      claudeChatUIConfig.applyModelDefaults(nextModel, settings);
    };

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
        context.notifyProviderModelOptionsChanged('claude');
      },
    };

    const installationContainer = container.createDiv();
    const lastProviderWarning = renderLastEnabledProviderWarning(container);

    const hostnameKey = getHostnameKey();
    const validatePath = (value: string): string | null => {
      const trimmed = value.trim();
      if (!trimmed) return null;

      const expandedPath = normalizeConfiguredCliPath(trimmed);

      if (!fs.existsSync(expandedPath)) {
        return t('settings.cliPath.validation.notExist');
      }
      const stat = fs.statSync(expandedPath);
      if (!stat.isFile()) {
        return t('settings.cliPath.validation.isDirectory');
      }
      return null;
    };

    renderCliInstallationSetting({
      cliName: 'Claude Code',
      icon: CLAUDE_PROVIDER_ICON,
      inspect: async () => {
        const settings = context.plugin.settings as unknown as Record<string, unknown>;
        const config = getClaudeProviderSettings(settings);
        return probeCliInstallation({
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
          () => claudeWorkspace.cliResolver.reset(),
        );
      },
      placeholder: process.platform === 'win32'
        ? 'D:\\nodejs\\node_global\\node_modules\\@anthropic-ai\\claude-code\\cli-wrapper.cjs'
        : '/usr/local/lib/node_modules/@anthropic-ai/claude-code/cli-wrapper.cjs',
      validate: validatePath,
    });

    // --- Models ---

    new Setting(container).setName(t('settings.models')).setHeading();

    new Setting(container)
      .setName('Default model')
      .setDesc('Used when a new conversation needs a Claude fallback model.')
      .addDropdown((dropdown) => {
        for (const option of getClaudeModelOptions(settingsBag)) {
          dropdown.addOption(option.value, option.label);
        }
        dropdown
          .setValue(claudeChatUIConfig.getDefaultModel?.(settingsBag) ?? '')
          .onChange(async (value) => {
            await context.plugin.mutateSettings((settings) => {
              const preference = resolveClaudeModelEnvironmentTypePreference(
                getClaudeModelOptions(settings),
                value,
              );
              updateClaudeProviderSettings(settings, {
                defaultModel: preference ?? value,
              });
            });
          });
      });

    new Setting(container)
      .setName(t('settings.customModels.name'))
      .setDesc(t('settings.customModels.desc'))
      .addTextArea((text) => {
        let pendingCustomModels = claudeSettings.customModels;
        let savedCustomModels = claudeSettings.customModels;

        const commitCustomModels = async (): Promise<void> => {
          if (pendingCustomModels === savedCustomModels) {
            return;
          }

          const nextCustomModels = pendingCustomModels;
          await context.plugin.mutateSettings((settings) => {
            updateClaudeProviderSettings(settings, { customModels: nextCustomModels });
            reconcileActiveClaudeModelSelection(settings);
            ProviderSettingsCoordinator.reconcileTitleGenerationModelSelection(settings);
          });
          savedCustomModels = nextCustomModels;
          context.notifyProviderModelOptionsChanged('claude');
        };

        text
          .setPlaceholder(t('settings.customModels.placeholder'))
          .setValue(claudeSettings.customModels)
          .onChange((value) => {
            pendingCustomModels = value;
          });
        text.inputEl.rows = 6;
        text.inputEl.cols = 40;
        text.inputEl.addEventListener('blur', () => {
          void commitCustomModels();
        });
      });

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
            await context.plugin.mutateSettings((settings) => {
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

    // --- Subagents ---

    new Setting(container).setName(t('settings.subagents.name')).setHeading();

    const agentsDesc = container.createDiv({ cls: 'claudian-sp-settings-desc' });
    agentsDesc.createEl('p', {
      text: t('settings.subagents.desc'),
      cls: 'setting-item-description',
    });

    const agentsContainer = container.createDiv({ cls: 'claudian-agents-container' });
    new AgentSettings(agentsContainer, {
      app: context.plugin.app,
      agentManager: claudeWorkspace.agentManager,
      agentStorage: claudeWorkspace.agentStorage,
    });

    // --- Plugins ---

    new Setting(container).setName(t('settings.plugins.name')).setHeading();

    const pluginsDesc = container.createDiv({ cls: 'claudian-plugin-settings-desc' });
    pluginsDesc.createEl('p', {
      text: t('settings.plugins.desc'),
      cls: 'setting-item-description',
    });

    const pluginsContainer = container.createDiv({ cls: 'claudian-plugins-container' });
    new PluginSettingsManager(pluginsContainer, {
      pluginManager: claudeWorkspace.pluginManager,
      agentManager: claudeWorkspace.agentManager,
      restartTabs: async () => {
        await context.plugin.runProviderExecutionTransition(['claude'], async () => {
          await claudeWorkspace.agentManager.loadAgents();
        });
      },
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

  },
};
