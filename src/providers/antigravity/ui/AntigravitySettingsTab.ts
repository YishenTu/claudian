import { Setting } from 'obsidian';

import { getInstallationKey } from '@/core/device/InstallationKey';
import { probeCLIInstallation } from '@/core/providers/cli/CLIInstallationProbe';
import { getRuntimeEnvironmentVariables } from '@/core/providers/providerEnvironment';
import { ProviderSettingsCoordinator } from '@/core/providers/ProviderSettingsCoordinator';
import type {
  ProviderSettingsTabRenderer,
  ProviderSettingsTabRendererContext,
} from '@/core/providers/types';
import { ANTIGRAVITY_PROVIDER_ICON } from '@/shared/icons';
import { renderCLIInstallationSetting } from '@/shared/settings/CLIInstallationSetting';
import { renderEnvironmentSettingsSection } from '@/shared/settings/EnvironmentSettingsSection';
import {
  renderLastEnabledProviderWarning,
  renderProviderModelEnablementWarning,
} from '@/shared/settings/ProviderModelEnablementWarning';

import { DEFAULT_ANTIGRAVITY_MODELS } from '../models';
import { getPlatformDownloadUrl } from '../runtime/AntigravityBinaryResolver';
import {
  getAntigravityProviderSettings,
  updateAntigravityProviderSettings,
} from '../settings';
import type {
  AntigravityAuthMethod,
  AntigravityPermissionMode,
} from '../types';

export function createAntigravitySettingsTab(): ProviderSettingsTabRenderer {
  return {
    render(container: HTMLElement, context: ProviderSettingsTabRendererContext) {
      const settingsBag = context.plugin.settings as unknown as Record<string, unknown>;
      const hostnameKey = getInstallationKey();

      const lastProviderWarning = renderLastEnabledProviderWarning(container);

      const modelWarning = renderProviderModelEnablementWarning(container, context, {
        getHasEnabledModels: () => getAntigravityProviderSettings(settingsBag).visibleModels.length > 0,
        getIsEnabled: () => getAntigravityProviderSettings(settingsBag).enabled,
        providerId: 'antigravity',
        providerName: 'Google Antigravity',
      });

      const enablement = {
        name: 'Google Antigravity',
        getDisabledReason: () => null,
        getValue: () => getAntigravityProviderSettings(settingsBag).enabled,
        onChange: async (value: boolean) => {
          let accepted = true;
          await context.plugin.runProviderExecutionTransition(['antigravity'], async () => {
            await context.plugin.mutateSettings((settings: any) => {
              accepted = ProviderSettingsCoordinator.applyProviderEnablement(
                settings,
                'antigravity',
                value,
              );
            });
          });
          if (accepted) {
            lastProviderWarning.hide();
          } else {
            lastProviderWarning.showFor();
          }
          modelWarning.context.notifyProviderModelOptionsChanged('antigravity');
        },
      };

      const installationContainer = container.createDiv();

      renderCLIInstallationSetting({
        cliName: 'Google Antigravity (agy_acp_server)',
        icon: ANTIGRAVITY_PROVIDER_ICON,
        inspect: async () => {
          const settings = context.plugin.settings as unknown as Record<string, unknown>;
          const config = getAntigravityProviderSettings(settings);
          const resolvedPath = await context.plugin.getResolvedProviderCliPath('antigravity');
          return probeCLIInstallation({
            path: resolvedPath,
            configuredPath: config.cliPathsByHost[hostnameKey] || config.cliPath,
            args: ['--help'],
            env: { ...process.env, ...getRuntimeEnvironmentVariables(settings, 'antigravity') },
          });
        },
        container: installationContainer,
        enablement,
        getValue: () => {
          const config = getAntigravityProviderSettings(settingsBag);
          return config.cliPathsByHost[hostnameKey] || config.cliPath;
        },
        name: 'Antigravity Server Path',
        onChange: async (value) => {
          const cliPathsByHost = {
            ...getAntigravityProviderSettings(settingsBag).cliPathsByHost,
          };
          if (value) {
            cliPathsByHost[hostnameKey] = value;
          } else {
            delete cliPathsByHost[hostnameKey];
          }

          await context.plugin.applyProviderRuntimeSettings(
            ['antigravity'],
            (settings: any) => {
              updateAntigravityProviderSettings(settings, { cliPathsByHost });
            },
          );
        },
        placeholder: process.platform === 'win32'
          ? 'C:\\Path\\To\\agy_acp_server.exe'
          : '/path/to/agy_acp_server.par',
        validate: validateCLIPath,
      });

      // Binary download notice if applicable
      const downloadUrl = getPlatformDownloadUrl();
      if (downloadUrl) {
        new Setting(container)
          .setName('Download Antigravity ACP Binary')
          .setDesc('Download the official Google Antigravity ACP server standalone binary for your current operating system.')
          .addButton((btn) => {
            btn.setButtonText('Download Binary Archive')
              .onClick(() => {
                window.open(downloadUrl, '_blank');
              });
          });
      }

      // Authentication
      new Setting(container).setName('Authentication').setHeading();

      new Setting(container)
        .setName('Authentication Method')
        .setDesc('Choose how Obsidian authenticates with Google Antigravity.')
        .addDropdown((dropdown) => {
          const currentMethod = getAntigravityProviderSettings(settingsBag).authMethod;
          dropdown
            .addOption('oauth-personal', 'OAuth Personal (Google Account)')
            .addOption('gemini-api-key', 'Gemini API Key')
            .addOption('oauth-business', 'OAuth Business')
            .addOption('agent-platform', 'Agent Platform')
            .setValue(currentMethod)
            .onChange(async (val) => {
              await context.plugin.applyProviderRuntimeSettings(
                ['antigravity'],
                (settings: any) => {
                  updateAntigravityProviderSettings(settings, {
                    authMethod: val as AntigravityAuthMethod,
                  });
                },
              );
              apiKeySetting.settingEl.style.display = val === 'gemini-api-key' ? '' : 'none';
            });
        });

      const apiKeySetting = new Setting(container)
        .setName('Gemini API Key')
        .setDesc('Enter your Gemini API key if authenticating with API key.')
        .addText((text) => {
          text
            .setPlaceholder('AIzaSy...')
            .setValue(getAntigravityProviderSettings(settingsBag).geminiApiKey)
            .onChange(async (val) => {
              await context.plugin.applyProviderRuntimeSettings(
                ['antigravity'],
                (settings: any) => {
                  updateAntigravityProviderSettings(settings, { geminiApiKey: val.trim() });
                },
              );
            });
          text.inputEl.type = 'password';
        });

      const currentAuth = getAntigravityProviderSettings(settingsBag).authMethod;
      apiKeySetting.settingEl.style.display = currentAuth === 'gemini-api-key' ? '' : 'none';

      // Permissions & Execution
      new Setting(container).setName('Permissions & Execution').setHeading();

      new Setting(container)
        .setName('Permission Mode')
        .setDesc('Control how tool execution and filesystem changes are approved.')
        .addDropdown((dropdown) => {
          const currentMode = getAntigravityProviderSettings(settingsBag).permissionMode;
          dropdown
            .addOption('default', 'Default (Ask before running tools)')
            .addOption('auto_edit', 'Auto Edit (Auto-approve file changes)')
            .addOption('yolo', 'YOLO (Auto-approve all tools)')
            .setValue(currentMode)
            .onChange(async (val) => {
              await context.plugin.applyProviderRuntimeSettings(
                ['antigravity'],
                (settings: any) => {
                  updateAntigravityProviderSettings(settings, {
                    permissionMode: val as AntigravityPermissionMode,
                  });
                },
              );
            });
        });

      new Setting(container)
        .setName('Server Arguments')
        .setDesc('Command-line arguments passed to agy_acp_server (e.g. --uid= on Linux).')
        .addText((text) => {
          text
            .setPlaceholder(process.platform === 'linux' ? '--uid=' : '')
            .setValue(getAntigravityProviderSettings(settingsBag).serverArguments)
            .onChange(async (val) => {
              await context.plugin.applyProviderRuntimeSettings(
                ['antigravity'],
                (settings: any) => {
                  updateAntigravityProviderSettings(settings, { serverArguments: val.trim() });
                },
              );
            });
        });

      // Default Model
      new Setting(container).setName('Models').setHeading();

      new Setting(container)
        .setName('Default Model')
        .setDesc('Primary model to use for chat turns and editing.')
        .addDropdown((dropdown) => {
          const currentModel = getAntigravityProviderSettings(settingsBag).selectedModel;
          for (const m of DEFAULT_ANTIGRAVITY_MODELS) {
            dropdown.addOption(m.rawId, m.label);
          }
          dropdown.setValue(currentModel);
          dropdown.onChange(async (val) => {
            await context.plugin.applyProviderRuntimeSettings(
              ['antigravity'],
              (settings: any) => {
                updateAntigravityProviderSettings(settings, { selectedModel: val });
              },
            );
          });
        });

      renderEnvironmentSettingsSection({
        container,
        plugin: context.plugin,
        scope: 'provider:antigravity',
        heading: 'Environment',
        name: 'Environment Variables',
        desc: 'Custom environment variables passed to the Antigravity ACP process.',
        placeholder: 'GEMINI_HOME=/path/to/home',
        renderCustomContextLimits: (target) => context.renderCustomContextLimits(target, 'antigravity'),
      });
    },
  };
}

function validateCLIPath(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  return null;
}
