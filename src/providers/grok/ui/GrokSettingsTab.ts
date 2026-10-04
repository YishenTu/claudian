import * as fs from 'node:fs';
import * as path from 'node:path';

import { Setting } from 'obsidian';

import { normalizeConfiguredCLIPath } from '@/core/process/cliPath';
import { probeCLIInstallation } from '@/core/providers/cli/CLIInstallationProbe';
import { getRuntimeEnvironmentVariables } from '@/core/providers/providerEnvironment';
import { GROK_PROVIDER_ICON } from '@/shared/icons';
import { renderCLIInstallationSetting } from '@/shared/settings/CLIInstallationSetting';

import { ProviderSettingsCoordinator } from '../../../core/providers/ProviderSettingsCoordinator';
import { ProviderWorkspaceRegistry } from '../../../core/providers/ProviderWorkspaceRegistry';
import type {
  ProviderSettingsTabRenderer
} from '../../../core/providers/types';
import type { ClaudianSettings } from '../../../core/types';
import { t } from '../../../i18n/i18n';
import { renderEnvironmentSettingsSection } from '../../../shared/settings/EnvironmentSettingsSection';
import type { ProviderEnablementSettingOptions } from '../../../shared/settings/ProviderEnablementSetting';
import {
  renderLastEnabledProviderWarning,
  renderProviderModelEnablementWarning,
} from '../../../shared/settings/ProviderModelEnablementWarning';
import { renderProviderModelsSection } from '../../../shared/settings/ProviderModelsSection';
import type { GrokWorkspaceServices } from '../app/GrokWorkspaceServices';
import {
  getGrokProviderSettings,
  updateGrokProviderSettings
} from '../settings';

const GROK_PROVIDER_ID = 'grok' as const;

export const grokSettingsTabRenderer: ProviderSettingsTabRenderer = {
  render(container, context) {
    const settingsBag = context.plugin.settings as unknown as Record<string, unknown>;
    const hostnameKey = context.plugin.storage.installationKey;
    const workspace = getGrokWorkspaceServices();

    const enablement: Omit<ProviderEnablementSettingOptions, 'container' | 'description'> = {
      getValue: () => getGrokProviderSettings(settingsBag).enabled,
      name: t('settings.providerEnablement.name', { provider: 'Grok Build' }),
      onChange: async (enabled) => {
        if (!ProviderSettingsCoordinator.canApplyProviderEnablement(
          settingsBag,
          GROK_PROVIDER_ID,
          enabled,
        )) {
          lastProviderWarning.showFor();
          return;
        }

        let accepted = true;
        await context.plugin.runProviderExecutionTransition(
          [GROK_PROVIDER_ID],
          async () => context.plugin.mutateSettings((settings) => {
            accepted = ProviderSettingsCoordinator.applyProviderEnablement(
              settings,
              GROK_PROVIDER_ID,
              enabled,
            );
          }),
        );
        if (accepted) {
          lastProviderWarning.hide();
        } else {
          lastProviderWarning.showFor();
        }
        modelWarning.context.notifyProviderModelOptionsChanged(GROK_PROVIDER_ID);
      },
    };

    const installationContainer = container.createDiv();
    const lastProviderWarning = renderLastEnabledProviderWarning(container);

    const modelWarning = renderProviderModelEnablementWarning(container, context, {
      getHasEnabledModels: () => {
        const current = getGrokProviderSettings(settingsBag);
        return (current.visibleModels ?? current.currentCatalog?.models ?? []).length > 0;
      },
      getIsEnabled: () => getGrokProviderSettings(settingsBag).enabled,
      providerId: GROK_PROVIDER_ID,
      providerName: 'Grok Build',
    });

    renderCLIInstallationSetting({
      cliName: 'Grok Build',
      icon: GROK_PROVIDER_ICON,
      inspect: async () => {
        const settings = context.plugin.settings as unknown as Record<string, unknown>;
        const config = getGrokProviderSettings(settings);
        return probeCLIInstallation({
          path: await context.plugin.getResolvedProviderCliPath('grok'),
          configuredPath: config.cliPathsByHost[hostnameKey] || config.cliPath,
          args: ['--version'],
          env: { ...process.env, ...getRuntimeEnvironmentVariables(settings, 'grok') },
        });
      },
      container: installationContainer,
      enablement,
      getValue: () => {
        const current = getGrokProviderSettings(settingsBag);
        return current.cliPathsByHost[hostnameKey] ?? current.cliPath ?? '';
      },
      name: t('settings.cliPath.genericName'),
      onChange: async (value) => {
        const cliPathsByHost = {
          ...getGrokProviderSettings(settingsBag).cliPathsByHost,
        };
        if (value) {
          cliPathsByHost[hostnameKey] = value;
        } else {
          delete cliPathsByHost[hostnameKey];
        }
        const mutation = (settings: ClaudianSettings): void => {
          updateGrokProviderSettings(settings, {
            cliPath: '',
            cliPathsByHost,
          });
        };
        await context.plugin.applyProviderRuntimeSettings(
          [GROK_PROVIDER_ID],
          mutation,
          () => workspace.cliResolver.reset(),
        );
        modelWarning.context.notifyProviderModelOptionsChanged(GROK_PROVIDER_ID);
      },
      placeholder: process.platform === 'win32'
        ? 'C:\\Users\\you\\AppData\\Roaming\\npm\\grok.cmd'
        : '/usr/local/bin/grok',
      validate: validateCLIPath,
    });

    new Setting(container).setName('Models').setHeading();
    const modelPicker = renderProviderModelsSection(container, 'grok', 'Grok Build', workspace.modelCatalog!, () => modelWarning.refresh());

    renderEnvironmentSettingsSection({
      container,
      desc: t('settings.grok.environment.desc'),
      heading: t('settings.environment'),
      name: t('settings.grok.environment.name'),
      placeholder: 'GROK_HOME=/path/to/grok-home\nGROK_DEFAULT_MODEL=grok-code-fast-1',
      plugin: context.plugin,
      renderCustomContextLimits: target => context.renderCustomContextLimits(target, GROK_PROVIDER_ID),
      scope: 'provider:grok',
    });
    return modelPicker;
  },
};

function validateCLIPath(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  const expandedPath = normalizeConfiguredCLIPath(trimmed);
  if (!path.posix.isAbsolute(expandedPath) && !path.win32.isAbsolute(expandedPath)) {
    return t('settings.cliPath.validation.mustBeAbsolute');
  }
  try {
    if (!fs.existsSync(expandedPath)) {
      return t('settings.cliPath.validation.notExist');
    }
    if (!fs.statSync(expandedPath).isFile()) {
      return t('settings.cliPath.validation.notFile');
    }
    if (process.platform !== 'win32') {
      fs.accessSync(expandedPath, fs.constants.X_OK);
    }
  } catch {
    return process.platform === 'win32'
      ? t('settings.cliPath.validation.notAccessible')
      : t('settings.cliPath.validation.notExecutable');
  }
  return null;
}

function getGrokWorkspaceServices(): GrokWorkspaceServices {
  return ProviderWorkspaceRegistry.requireServices(GROK_PROVIDER_ID) as GrokWorkspaceServices;
}
