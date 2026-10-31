
import type { ProviderCLIResolver } from '@/core/providers/types';
import { OPENAI_PROVIDER_ICON } from '@/shared/icons';
import { AccessibleSetting } from '@/shared/settings/AccessibleSetting';
import { renderCLIInstallationSetting } from '@/shared/settings/CLIInstallationSetting';
import { renderExecutionTargetSettings, validateExecutionTargetCLIPath } from '@/shared/settings/ExecutionTargetSettings';

import type { ProviderModelCatalog } from '../../../core/providers/models/ProviderModelCatalog';
import { ProviderSettingsCoordinator } from '../../../core/providers/ProviderSettingsCoordinator';
import type { ProviderSettingsTabRenderer } from '../../../core/providers/types';
import { t } from '../../../i18n/i18n';
import { renderEnvironmentSettingsSection } from '../../../shared/settings/EnvironmentSettingsSection';
import type { ProviderEnablementSettingOptions } from '../../../shared/settings/ProviderEnablementSetting';
import {
  renderLastEnabledProviderWarning,
  renderProviderModelEnablementWarning,
} from '../../../shared/settings/ProviderModelEnablementWarning';
import { renderProviderModelsSection } from '../../../shared/settings/ProviderModelsSection';
import { getCodexModelOptions } from '../modelOptions';
import { inspectCodexInstallation } from '../runtime/CodexCLIInstallation';
import { getCodexProviderSettings, updateCodexProviderSettings } from '../settings';

export function createCodexSettingsTabRenderer(
  codexWorkspace: { cliResolver: Pick<ProviderCLIResolver, 'reset'>; modelCatalog: ProviderModelCatalog; },
): ProviderSettingsTabRenderer {
  return {
    render(container, context) {
      const settingsBag = context.plugin.settings as unknown as Record<string, unknown>;
      const codexSettings = getCodexProviderSettings(settingsBag);
      const hostnameKey = context.plugin.storage.installationKey;
      const isWindowsHost = process.platform === 'win32';

      // --- Setup ---

      const enablement: Omit<ProviderEnablementSettingOptions, 'container' | 'description'> = {
        getValue: () => getCodexProviderSettings(settingsBag).enabled,
        name: t('settings.providerEnablement.name', { provider: 'Codex' }),
        onChange: async (value) => {
          if (!ProviderSettingsCoordinator.canApplyProviderEnablement(
            settingsBag,
            'codex',
            value,
          )) {
            lastProviderWarning.showFor();
            return;
          }

          let accepted = true;
          await context.plugin.runProviderExecutionTransition(['codex'], async () => {
            await context.plugin.mutateSettings((settings) => {
              accepted = ProviderSettingsCoordinator.applyProviderEnablement(
                settings,
                'codex',
                value,
              );
            });
          });
          if (accepted) {
            lastProviderWarning.hide();
          } else {
            lastProviderWarning.showFor();
          }
          modelWarning.context.notifyProviderModelOptionsChanged('codex');
        },
      };

      const installationContainer = container.createDiv();
      const lastProviderWarning = renderLastEnabledProviderWarning(container);

      const modelWarning = renderProviderModelEnablementWarning(container, context, {
        getHasEnabledModels: () => getCodexModelOptions(getCodexProviderSettings(settingsBag)).length > 0,
        getIsEnabled: () => getCodexProviderSettings(settingsBag).enabled,
        providerId: 'codex',
        providerName: 'Codex',
      });

      const getCliPathCopy = (): { placeholder: string } => {
        if (!isWindowsHost) {
          return {
            placeholder: '/usr/local/bin/codex',
          };
        }

        if (getCodexProviderSettings(settingsBag).installationMethod === 'wsl') {
          return {
            placeholder: 'codex',
          };
        }

        return {
          placeholder: 'C:\\Users\\you\\AppData\\Roaming\\npm\\codex.exe',
        };
      };

      const cliPathControl = renderCLIInstallationSetting({
        cliName: 'Codex CLI',
        icon: OPENAI_PROVIDER_ICON,
        inspect: () => inspectCodexInstallation(context.plugin.getRuntimeHost('codex')),
        container: installationContainer,
        enablement,
        getValue: () => {
          const config = getCodexProviderSettings(settingsBag);
          return config.cliPathsByHost[hostnameKey] || config.cliPath;
        },
        name: t('settings.codex.cliPath.name'),
        onChange: async (value) => {
          const cliPathsByHost = {
            ...getCodexProviderSettings(settingsBag).cliPathsByHost,
          };
          if (value) {
            cliPathsByHost[hostnameKey] = value;
          } else {
            delete cliPathsByHost[hostnameKey];
          }

          await context.plugin.applyProviderRuntimeSettings(
            ['codex'],
            (settings) => {
              updateCodexProviderSettings(settings, { cliPathsByHost, cliPath: '' });
            },
            () => codexWorkspace.cliResolver.reset(),
          );
        },
        placeholder: getCliPathCopy().placeholder,
        validate: value => validateExecutionTargetCLIPath(value, getCodexProviderSettings(settingsBag)),
      });

      renderExecutionTargetSettings({
        container, providerName: 'Codex',
        getValue: () => getCodexProviderSettings(settingsBag),
        onChange: async updates => {
          await context.plugin.applyProviderRuntimeSettings(
            ['codex'],
            settings => { updateCodexProviderSettings(settings, updates); },
            () => codexWorkspace.cliResolver.reset(),
          );
        },
        onRefresh: () => {
          cliPathControl.setPlaceholder(getCliPathCopy().placeholder);
          cliPathControl.revalidate();
          void cliPathControl.refresh();
        },
      });

      // --- Models ---

      new AccessibleSetting(container).setName(t('settings.models')).setHeading();

      const modelPicker = renderProviderModelsSection(container, 'codex', 'Codex', codexWorkspace.modelCatalog, () => modelWarning.refresh());

      new AccessibleSetting(container)
        .setName(t('settings.codex.ultraEffort.name'))
        .setDesc(t('settings.codex.ultraEffort.desc'))
        .addToggle(toggle => toggle
          .setValue(codexSettings.enableUltraEffort)
          .onChange(async (value) => {
            await context.plugin.mutateSettings((settings) => {
              updateCodexProviderSettings(settings, { enableUltraEffort: value });
              ProviderSettingsCoordinator.normalizeAllModelVariants(settings);
            });
            modelPicker.refresh();
            context.notifyProviderModelOptionsChanged('codex');
          }));

      // --- Responses ---

      new AccessibleSetting(container).setName(t('settings.responses')).setHeading();

      new AccessibleSetting(container)
        .setName(t('settings.codex.responseStyle.name'))
        .setDesc(t('settings.codex.responseStyle.desc'))
        .addDropdown((dropdown) => {
          dropdown.selectEl.setAttribute('aria-label', t('settings.codex.responseStyle.name'));
          dropdown
            .addOption('none', t('settings.codex.responseStyle.neutral'))
            .addOption('pragmatic', t('settings.codex.responseStyle.pragmatic'))
            .addOption('friendly', t('settings.codex.responseStyle.friendly'))
            .setValue(codexSettings.responseStyle)
            .onChange(async (value) => {
              await context.plugin.mutateSettings((settings) => {
                updateCodexProviderSettings(settings, {
                  responseStyle: value === 'friendly' || value === 'none' ? value : 'pragmatic',
                });
              });
            });
        });

      new AccessibleSetting(container)
        .setName(t('settings.codex.responseVerbosity.name'))
        .setDesc(t('settings.codex.responseVerbosity.desc'))
        .addDropdown((dropdown) => {
          dropdown.selectEl.setAttribute('aria-label', t('settings.codex.responseVerbosity.name'));
          for (const value of ['default', 'low', 'medium', 'high'] as const) {
            dropdown.addOption(value, t(`settings.codex.responseVerbosity.${value}`));
          }
          dropdown.setValue(codexSettings.responseVerbosity).onChange(async (value) => {
            await context.plugin.mutateSettings((settings) => {
              updateCodexProviderSettings(settings, {
                responseVerbosity: value === 'low' || value === 'medium' || value === 'high' ? value : 'default',
              });
            });
          });
        });

      const SUMMARY_OPTIONS: { value: string; label: string }[] = [
        { value: 'auto', label: t('settings.codex.reasoningSummary.auto') },
        { value: 'concise', label: t('settings.codex.reasoningSummary.concise') },
        { value: 'detailed', label: t('settings.codex.reasoningSummary.detailed') },
        { value: 'none', label: t('settings.codex.reasoningSummary.off') },
      ];

      new AccessibleSetting(container)
        .setName(t('settings.codex.reasoningSummary.name'))
        .setDesc(t('settings.codex.reasoningSummary.desc'))
        .addDropdown((dropdown) => {
          for (const opt of SUMMARY_OPTIONS) {
            dropdown.addOption(opt.value, opt.label);
          }
          dropdown.setValue(codexSettings.reasoningSummary);
          dropdown.onChange(async (value) => {
            await context.plugin.mutateSettings((settings) => {
              updateCodexProviderSettings(
                settings,
                { reasoningSummary: value as 'auto' | 'concise' | 'detailed' | 'none' },
              );
            });
          });
        });

      // --- Safety ---

      new AccessibleSetting(container).setName(t('settings.safety')).setHeading();

      new AccessibleSetting(container)
        .setName(t('settings.codexSandbox.name'))
        .setDesc(t('settings.codexSandbox.desc'))
        .addDropdown((dropdown) => {
          dropdown
            .addOption('workspace-write', t('settings.codex.safeMode.workspaceWrite'))
            .addOption('read-only', t('settings.codex.safeMode.readOnly'))
            .setValue(codexSettings.safeMode)
            .onChange(async (value) => {
              await context.plugin.mutateSettings((settings) => {
                updateCodexProviderSettings(
                  settings,
                  { safeMode: value as 'workspace-write' | 'read-only' },
                );
              });
            });
        });

      // --- Environment ---

      renderEnvironmentSettingsSection({
        container,
        plugin: context.plugin,
        scope: 'provider:codex',
        heading: t('settings.environment'),
        name: t('settings.codex.environment.name'),
        desc: t('settings.codex.environment.desc'),
        placeholder: `OPENAI_API_KEY=your-key\nOPENAI_BASE_URL=https://api.openai.com/v1\nCODEX_SANDBOX=workspace-write`,
        renderCustomContextLimits: (target) => context.renderCustomContextLimits(target, 'codex'),
      });
      return modelPicker;
    },
  };
}
