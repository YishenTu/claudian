import * as fs from 'fs';

import { normalizeConfiguredCLIPath } from '@/core/process/cliPath';
import { resolveExecutionTargetAsync } from '@/core/process/execution-target/ExecutionTargetResolver';
import { probeTargetCLIInstallation } from '@/core/providers/cli/TargetCLIInstallationProbe';
import { getRuntimeEnvironmentText } from '@/core/providers/providerEnvironment';
import type { ProviderCLIResolver } from '@/core/providers/types';
import { OPENCODE_PROVIDER_ICON } from '@/shared/icons';
import { AccessibleSetting } from '@/shared/settings/AccessibleSetting';
import { renderCLIInstallationSetting } from '@/shared/settings/CLIInstallationSetting';
import { renderExecutionTargetSettings, validateExecutionTargetCLIPath } from '@/shared/settings/ExecutionTargetSettings';

import type { ProviderModelCatalog } from '../../../core/providers/models/ProviderModelCatalog';
import { ProviderSettingsCoordinator } from '../../../core/providers/ProviderSettingsCoordinator';
import type {
  ProviderSettingsTabRenderer
} from '../../../core/providers/types';
import { t } from '../../../i18n/i18n';
import { renderEnvironmentSettingsSection } from '../../../shared/settings/EnvironmentSettingsSection';
import type { ProviderEnablementSettingOptions } from '../../../shared/settings/ProviderEnablementSetting';
import {
  renderLastEnabledProviderWarning,
  renderProviderModelEnablementWarning,
} from '../../../shared/settings/ProviderModelEnablementWarning';
import { renderProviderModelsSection } from '../../../shared/settings/ProviderModelsSection';
import type { OpencodeMetadataService } from '../metadata/OpencodeMetadataService';
import { resolveOpencodeWSLCLIPath } from '../runtime/opencodeCLIReference';
import { getOpencodeWSLForwardedEnvironment, opencodeEnvironment } from '../runtime/OpencodeExecutionTarget';
import { buildOpencodeRuntimeEnv } from '../runtime/OpencodeRuntimeEnvironment';
import {
  getOpencodeProviderSettings,
  updateOpencodeProviderSettings
} from '../settings';
import { renderOpencodeMigrationNotice } from './OpencodeMigrationNotice';

export function createOpencodeSettingsTabRenderer(
  opencodeWorkspace: { cliResolver: Pick<ProviderCLIResolver, 'reset'>; metadataService: Pick<OpencodeMetadataService, 'loadCatalog' | 'warmModelMetadata'>; modelCatalog: ProviderModelCatalog; },
): ProviderSettingsTabRenderer {
  return {
    render(container, context) {
      const settingsBag = context.plugin.settings as unknown as Record<string, unknown>;
      const hostnameKey = context.plugin.storage.installationKey;

      const enablement: Omit<ProviderEnablementSettingOptions, 'container' | 'description'> = {
        getValue: () => getOpencodeProviderSettings(settingsBag).enabled,
        name: t('settings.providerEnablement.name', { provider: 'OpenCode' }),
        onChange: async (value) => {
          if (!ProviderSettingsCoordinator.canApplyProviderEnablement(
            settingsBag,
            'opencode',
            value,
          )) {
            lastProviderWarning.showFor();
            return;
          }

          let accepted = true;
          await context.plugin.runProviderExecutionTransition(['opencode'], async () => {
            await context.plugin.mutateSettings((settings) => {
              accepted = ProviderSettingsCoordinator.applyProviderEnablement(
                settings,
                'opencode',
                value,
              );
            });
          });
          if (accepted) {
            lastProviderWarning.hide();
          } else {
            lastProviderWarning.showFor();
          }
          modelWarning.context.notifyProviderModelOptionsChanged('opencode');
        },
      };

      const installationContainer = container.createDiv();
      const updateMigrationNotice = renderOpencodeMigrationNotice(container);
      const lastProviderWarning = renderLastEnabledProviderWarning(container);

      const modelWarning = renderProviderModelEnablementWarning(container, context, {
        getHasEnabledModels: () => getOpencodeProviderSettings(settingsBag).visibleModels.length > 0,
        getIsEnabled: () => getOpencodeProviderSettings(settingsBag).enabled,
        providerId: 'opencode',
        providerName: 'OpenCode',
      });

      const cliPathControl = renderCLIInstallationSetting({
        cliName: 'OpenCode',
        icon: OPENCODE_PROVIDER_ICON,
        inspect: async () => {
          const settings = context.plugin.settings as unknown as Record<string, unknown>;
          const config = getOpencodeProviderSettings(settings);
          const hostCwd = context.plugin.workingDirectory ?? process.cwd();
          const target = await resolveExecutionTargetAsync({ settings: config, hostVaultPath: hostCwd });
          const command = target.method === 'wsl' ? resolveOpencodeWSLCLIPath(config) : await context.plugin.getResolvedProviderCliPath('opencode');
          const environmentText = getRuntimeEnvironmentText(settings, 'opencode');
          const env = opencodeEnvironment(buildOpencodeRuntimeEnv(environmentText, command ?? '', undefined, undefined, target));
          const installation = await probeTargetCLIInstallation({
            target, hostCwd, command,
            forwardEnvironment: getOpencodeWSLForwardedEnvironment(env, environmentText),
            configuredPath: config.cliPathsByHost[hostnameKey] || config.cliPath,
            args: ['--version'],
            env,
          });
          updateMigrationNotice(installation.version);
          return installation;
        },
        container: installationContainer,
        enablement,
        getValue: () => {
          const config = getOpencodeProviderSettings(settingsBag);
          return config.cliPathsByHost[hostnameKey] || config.cliPath;
        },
        name: t('settings.cliPath.genericName'),
        onChange: async (value) => {
          const cliPathsByHost = {
            ...getOpencodeProviderSettings(settingsBag).cliPathsByHost,
          };
          if (value) {
            cliPathsByHost[hostnameKey] = value;
          } else {
            delete cliPathsByHost[hostnameKey];
          }

          await context.plugin.applyProviderRuntimeSettings(
            ['opencode'],
            (settings) => {
              updateOpencodeProviderSettings(settings, { cliPathsByHost });
            },
            () => opencodeWorkspace?.cliResolver?.reset(),
          );
        },
        placeholder: process.platform === 'win32' && getOpencodeProviderSettings(settingsBag).installationMethod === 'wsl' ? 'opencode' : process.platform === 'win32'
          ? 'C:\\Users\\you\\AppData\\Roaming\\npm\\opencode.cmd'
          : '/usr/local/bin/opencode',
        validate: value => process.platform === 'win32' && getOpencodeProviderSettings(settingsBag).installationMethod === 'wsl'
          ? validateExecutionTargetCLIPath(value, getOpencodeProviderSettings(settingsBag)) : validateCLIPath(value),
      });

      renderExecutionTargetSettings({
        container, providerName: 'OpenCode',
        getValue: () => getOpencodeProviderSettings(settingsBag),
        onChange: async updates => {
          await context.plugin.applyProviderRuntimeSettings(['opencode'],
            settings => { updateOpencodeProviderSettings(settings, updates); },
            () => opencodeWorkspace.cliResolver.reset());
        },
        onRefresh: () => {
          cliPathControl.setPlaceholder(getOpencodeProviderSettings(settingsBag).installationMethod === 'wsl' ? 'opencode' : 'C:\\Users\\you\\AppData\\Roaming\\npm\\opencode.cmd');
          cliPathControl.revalidate();
          void cliPathControl.refresh();
        },
      });

      new AccessibleSetting(container).setName('Models').setHeading();
      const modelPicker = renderProviderModelsSection(
        container, 'opencode', 'OpenCode', opencodeWorkspace.modelCatalog, () => modelWarning.refresh(),
        t('settings.opencode.emptyModels'),
      );

      renderEnvironmentSettingsSection({
        container,
        plugin: context.plugin,
        scope: 'provider:opencode',
        heading: t('settings.environment'),
        name: t('settings.opencode.environment.name'),
        desc: t('settings.opencode.environment.desc'),
        placeholder: 'OPENCODE_DB=/path/to/opencode.db',
        renderCustomContextLimits: (target) => context.renderCustomContextLimits(target, 'opencode'),
      });
      return modelPicker;
    },
  };
}

function validateCLIPath(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  const expandedPath = normalizeConfiguredCLIPath(trimmed);
  if (!fs.existsSync(expandedPath)) {
    return t('settings.cliPath.validation.notExist');
  }
  if (!fs.statSync(expandedPath).isFile()) {
    return t('settings.cliPath.validation.notFile');
  }
  return null;
}
