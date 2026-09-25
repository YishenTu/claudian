import * as fs from 'fs';
import { Setting } from 'obsidian';

import { probeCLIInstallation } from '@/core/providers/cli/CLIInstallationProbe';
import { getRuntimeEnvironmentVariables } from '@/core/providers/providerEnvironment';
import type { ProviderCLIResolver } from '@/core/providers/types';
import { OPENCODE_PROVIDER_ICON } from '@/shared/icons';
import { renderCLIInstallationSetting } from '@/shared/settings/CLIInstallationSetting';

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
import { getHostnameKey } from '../../../utils/env';
import { normalizeConfiguredCLIPath } from '../../../utils/path';
import type { OpencodeMetadataService } from '../metadata/OpencodeMetadataService';
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
      const hostnameKey = getHostnameKey();

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

      renderCLIInstallationSetting({
        cliName: 'OpenCode CLI',
        icon: OPENCODE_PROVIDER_ICON,
        inspect: async () => {
          const settings = context.plugin.settings as unknown as Record<string, unknown>;
          const config = getOpencodeProviderSettings(settings);
          const installation = await probeCLIInstallation({
            path: await context.plugin.getResolvedProviderCliPath('opencode'),
            configuredPath: config.cliPathsByHost[hostnameKey] || config.cliPath,
            args: ['--version'],
            env: { ...process.env, ...getRuntimeEnvironmentVariables(settings, 'opencode') },
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
        name: 'CLI path',
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
        placeholder: process.platform === 'win32'
          ? 'C:\\Users\\you\\AppData\\Roaming\\npm\\opencode.cmd'
          : '/usr/local/bin/opencode',
        validate: validateCLIPath,
      });

      new Setting(container).setName('Models').setHeading();
      const modelPicker = renderProviderModelsSection(container, 'opencode', 'OpenCode', opencodeWorkspace.modelCatalog, () => modelWarning.refresh());

      new Setting(container).setName(t('settings.agentSkills.sectionTitle')).setHeading();
      context.renderAgentSkillSettings(container, 'opencode');

      new Setting(container).setName('Commands').setHeading();
      context.renderHiddenProviderCommandSetting(container, 'opencode', {
        name: 'Hidden Commands and Skills',
        desc: 'Hide specific OpenCode commands and skills from the dropdown. Enter names without the leading slash, one per line.',
        placeholder: 'compact\nreview\nfix',
      });

      renderEnvironmentSettingsSection({
        container,
        plugin: context.plugin,
        scope: 'provider:opencode',
        heading: 'Environment',
        name: 'Environment Variables',
        desc: 'Extra environment variables passed to OpenCode.',
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
    return 'Path does not exist';
  }
  if (!fs.statSync(expandedPath).isFile()) {
    return 'Path must point to a file';
  }
  return null;
}
