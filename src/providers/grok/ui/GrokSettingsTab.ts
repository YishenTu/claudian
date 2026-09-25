import * as fs from 'node:fs';
import * as path from 'node:path';

import { Setting } from 'obsidian';

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
import { getHostnameKey } from '../../../utils/env';
import { normalizeConfiguredCLIPath } from '../../../utils/path';
import type { GrokWorkspaceServices } from '../app/GrokWorkspaceServices';
import {
  getGrokProviderSettings,
  updateGrokProviderSettings
} from '../settings';

const GROK_PROVIDER_ID = 'grok' as const;

export const grokSettingsTabRenderer: ProviderSettingsTabRenderer = {
  render(container, context) {
    const settingsBag = context.plugin.settings as unknown as Record<string, unknown>;
    const hostnameKey = getHostnameKey();
    const workspace = getGrokWorkspaceServices();

    const enablement: Omit<ProviderEnablementSettingOptions, 'container' | 'description'> = {
      getValue: () => getGrokProviderSettings(settingsBag).enabled,
      name: t('settings.providerEnablement.name', { provider: 'Grok' }),
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
      providerName: 'Grok',
    });

    renderCLIInstallationSetting({
      cliName: 'Grok CLI',
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
      name: 'CLI path',
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
    const modelPicker = renderProviderModelsSection(container, 'grok', 'Grok', workspace.modelCatalog!, () => modelWarning.refresh());

    new Setting(container).setName(t('settings.agentSkills.sectionTitle')).setHeading();
    context.renderAgentSkillSettings(container, GROK_PROVIDER_ID);

    new Setting(container).setName('Commands').setHeading();
    context.renderHiddenProviderCommandSetting(container, GROK_PROVIDER_ID, {
      name: 'Hidden Grok commands',
      desc: 'Hide runtime commands advertised by Grok from the command dropdown. Enter names without the leading slash, one per line.',
      placeholder: 'compact\nreview',
    });

    renderEnvironmentSettingsSection({
      container,
      desc: 'Environment variables passed only to Grok. Custom-model secrets stay in this provider scope and are referenced from native config by env_key.',
      heading: 'Environment',
      name: 'Grok environment variables',
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
    return 'Path must be absolute';
  }
  try {
    if (!fs.existsSync(expandedPath)) {
      return 'Path does not exist';
    }
    if (!fs.statSync(expandedPath).isFile()) {
      return 'Path must point to a file';
    }
    if (process.platform !== 'win32') {
      fs.accessSync(expandedPath, fs.constants.X_OK);
    }
  } catch {
    return process.platform === 'win32'
      ? 'Path is not accessible'
      : 'Path must be executable';
  }
  return null;
}

function getGrokWorkspaceServices(): GrokWorkspaceServices {
  return ProviderWorkspaceRegistry.requireServices(GROK_PROVIDER_ID) as GrokWorkspaceServices;
}
