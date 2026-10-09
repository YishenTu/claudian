import { Setting } from 'obsidian';

import { probeCLIInstallation } from '@/core/providers/cli/CLIInstallationProbe';
import type { ProviderModelCatalogController } from '@/core/providers/models/ProviderModelCatalog';
import { getRuntimeEnvironmentVariables } from '@/core/providers/providerEnvironment';
import { ProviderSettingsCoordinator } from '@/core/providers/ProviderSettingsCoordinator';
import type { ProviderSettingsTabRenderer } from '@/core/providers/types';
import { t } from '@/i18n/i18n';
import { DEEPSEEK_PROVIDER_ICON } from '@/shared/icons';
import { renderCLIInstallationSetting } from '@/shared/settings/CLIInstallationSetting';
import { renderEnvironmentSettingsSection } from '@/shared/settings/EnvironmentSettingsSection';
import { renderLastEnabledProviderWarning, renderProviderModelEnablementWarning } from '@/shared/settings/ProviderModelEnablementWarning';
import { renderProviderModelsSection } from '@/shared/settings/ProviderModelsSection';

import type { DeepSeekCLIResolver } from '../runtime/DeepSeekCLIResolver';
import { getDeepSeekProviderSettings, updateDeepSeekProviderSettings } from '../settings';

export function createDeepSeekSettingsTabRenderer(workspace: { cliResolver: DeepSeekCLIResolver; modelCatalog: ProviderModelCatalogController }): ProviderSettingsTabRenderer {
  return {
    render(container, context) {
      const host = context.plugin;
      const settings = (): ReturnType<typeof getDeepSeekProviderSettings> => getDeepSeekProviderSettings(host.settings);
      const installation = container.createDiv({ cls: 'claudian-deepseek-installation' });
      const warning = renderLastEnabledProviderWarning(container);
      const modelWarning = renderProviderModelEnablementWarning(container, context, { providerId: 'deepseek', providerName: 'DeepSeek Harness',
        getHasEnabledModels: () => settings().visibleModels.length > 0, getIsEnabled: () => settings().enabled,
      });
      renderCLIInstallationSetting({ container: installation, cliName: 'DeepSeek Harness', icon: DEEPSEEK_PROVIDER_ICON, name: t('settings.cliPath.genericName'),
        placeholder: '/usr/local/bin/dsh', getValue: () => settings().cliPathsByHost[host.storage.installationKey] ?? settings().cliPath,
        validate: () => null,
        inspect: async () => probeCLIInstallation({ path: await host.getResolvedProviderCliPath('deepseek'),
          configuredPath: settings().cliPathsByHost[host.storage.installationKey] ?? settings().cliPath,
          args: ['--version'], env: { ...process.env, ...getRuntimeEnvironmentVariables(host.settings, 'deepseek') },
        }),
        onChange: async cliPath => {
          await host.applyProviderRuntimeSettings(['deepseek'], settings => { updateDeepSeekProviderSettings(settings, { cliPath }); }, () => workspace.cliResolver.reset());
        },
        enablement: { name: t('settings.providerEnablement.name', { provider: 'DeepSeek Harness' }), getValue: () => settings().enabled,
          onChange: async enabled => {
            if (!ProviderSettingsCoordinator.canApplyProviderEnablement(host.settings, 'deepseek', enabled)) { warning.showFor(); return; }
            await host.runProviderExecutionTransition(['deepseek'], async () => host.mutateSettings(settings => {
              ProviderSettingsCoordinator.applyProviderEnablement(settings, 'deepseek', enabled);
            }));
            warning.hide(); modelWarning.context.notifyProviderModelOptionsChanged('deepseek');
          },
        },
      });
      new Setting(container).setName(t('settings.models')).setHeading();
      const picker = renderProviderModelsSection(container, 'deepseek', 'DeepSeek Harness', workspace.modelCatalog, () => modelWarning.refresh());
      new Setting(container).setName(t('settings.deepseek.preset')).setHeading();
      new Setting(container).setName(t('settings.deepseek.codeMode.name')).setDesc(t('settings.deepseek.codeMode.desc'))
        .addToggle(toggle => {
          toggle.setValue(settings().codeMode).onChange(async codeMode => { await host.mutateSettings(settings => { updateDeepSeekProviderSettings(settings, { codeMode }); }); });
          toggle.toggleEl.setAttribute('aria-label', t('settings.deepseek.codeMode.name'));
        });
      renderEnvironmentSettingsSection({ container, plugin: host, scope: 'provider:deepseek', heading: t('settings.environment'), name: t('settings.deepseek.environment.name'),
        desc: t('settings.deepseek.environment.desc'),
        placeholder: 'DSH_HOME=/path/to/.dsh', renderCustomContextLimits: target => context.renderCustomContextLimits(target, 'deepseek'),
      });
      return picker;
    },
  };
}
