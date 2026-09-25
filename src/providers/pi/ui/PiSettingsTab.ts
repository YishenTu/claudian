import * as fs from 'node:fs';

import { Setting } from 'obsidian';

import { probeCLIInstallation } from '@/core/providers/cli/CLIInstallationProbe';
import { getRuntimeEnvironmentVariables } from '@/core/providers/providerEnvironment';
import type { ProviderCLIResolver } from '@/core/providers/types';
import { PI_PROVIDER_ICON } from '@/shared/icons';
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
import { resolvePiProcessSpec } from '../runtime/PiSubprocess';
import {
  getPiProviderSettings,
  updatePiProviderSettings
} from '../settings';

export function createPiSettingsTabRenderer(
  workspace: { cliResolver: Pick<ProviderCLIResolver, 'reset'>; modelCatalog: ProviderModelCatalog; },
): ProviderSettingsTabRenderer {
  return {
    render(container, context) {
      const settingsBag = context.plugin.settings as unknown as Record<string, unknown>;
      const hostnameKey = getHostnameKey();

      const enablement: Omit<ProviderEnablementSettingOptions, 'container' | 'description'> = {
        getValue: () => getPiProviderSettings(settingsBag).enabled,
        name: t('settings.providerEnablement.name', { provider: 'Pi' }),
        onChange: async (value) => {
          if (!ProviderSettingsCoordinator.canApplyProviderEnablement(
            settingsBag,
            'pi',
            value,
          )) {
            lastProviderWarning.showFor();
            return;
          }

          let accepted = true;
          await context.plugin.runProviderExecutionTransition(['pi'], async () => {
            await context.plugin.mutateSettings((settings) => {
              accepted = ProviderSettingsCoordinator.applyProviderEnablement(
                settings,
                'pi',
                value,
              );
            });
          });
          if (accepted) {
            lastProviderWarning.hide();
          } else {
            lastProviderWarning.showFor();
          }
          modelWarning.context.notifyProviderModelOptionsChanged('pi');
        },
      };

      const installationContainer = container.createDiv();
      const lastProviderWarning = renderLastEnabledProviderWarning(container);

      const modelWarning = renderProviderModelEnablementWarning(container, context, {
        getHasEnabledModels: () => getPiProviderSettings(settingsBag).visibleModels.length > 0,
        getIsEnabled: () => getPiProviderSettings(settingsBag).enabled,
        providerId: 'pi',
        providerName: 'Pi',
      });

      renderCLIInstallationSetting({
        cliName: 'Pi CLI',
        icon: PI_PROVIDER_ICON,
        inspect: async () => {
          const settings = context.plugin.settings as unknown as Record<string, unknown>;
          const config = getPiProviderSettings(settings);
          return probeCLIInstallation({
            path: await context.plugin.getResolvedProviderCliPath('pi'),
            configuredPath: config.cliPathsByHost[hostnameKey] || config.cliPath,
            args: ['--version'],
            env: { ...process.env, ...getRuntimeEnvironmentVariables(settings, 'pi') },
            prepareLaunch: (spec) => ({ ...spec, ...resolvePiProcessSpec(spec, spec.env.PATH ?? '') }),
          });
        },
        container: installationContainer,
        enablement,
        getValue: () => {
          const config = getPiProviderSettings(settingsBag);
          return config.cliPathsByHost[hostnameKey] || config.cliPath;
        },
        name: 'CLI path',
        onChange: async (value) => {
          const cliPathsByHost = {
            ...getPiProviderSettings(settingsBag).cliPathsByHost,
          };
          if (value) {
            cliPathsByHost[hostnameKey] = value;
          } else {
            delete cliPathsByHost[hostnameKey];
          }

          await context.plugin.applyProviderRuntimeSettings(
            ['pi'],
            (settings) => {
              updatePiProviderSettings(settings, {
                cliPathsByHost,
              });
            },
            () => workspace?.cliResolver?.reset(),
          );
          context.notifyProviderModelOptionsChanged('pi');
        },
        placeholder: process.platform === 'win32'
          ? 'C:\\Users\\you\\AppData\\Roaming\\npm\\pi.cmd'
          : '/usr/local/bin/pi',
        validate: validateCLIPath,
      });

      new Setting(container).setName('Models').setHeading();
      const modelPicker = renderProviderModelsSection(container, 'pi', 'Pi', workspace.modelCatalog, () => modelWarning.refresh());

      new Setting(container).setName(t('settings.agentSkills.sectionTitle')).setHeading();
      context.renderAgentSkillSettings(container, 'pi');

      new Setting(container).setName('Commands').setHeading();
      context.renderHiddenProviderCommandSetting(container, 'pi', {
        name: 'Hidden Pi commands and skills',
        desc: 'Hide runtime commands and skills advertised by Pi from the command dropdown. Enter exact names without the leading slash, one per line.',
        placeholder: 'skill:review\ncompact',
      });

      renderEnvironmentSettingsSection({
        container,
        desc: 'Environment variables passed only to Pi.',
        heading: 'Environment',
        name: 'Pi environment variables',
        placeholder: 'PI_CODING_AGENT_SESSION_DIR=/path/to/sessions',
        plugin: context.plugin,
        scope: 'provider:pi',
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
