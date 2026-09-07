import * as fs from 'node:fs';
import * as path from 'node:path';

import { Notice, Setting } from 'obsidian';

import { ProviderSettingsCoordinator } from '../../../core/providers/ProviderSettingsCoordinator';
import { ProviderWorkspaceRegistry } from '../../../core/providers/ProviderWorkspaceRegistry';
import type {
  ProviderSettingsTabRenderer,
  ProviderSettingsTabRendererContext,
} from '../../../core/providers/types';
import type { ClaudianSettings } from '../../../core/types';
import { t } from '../../../i18n/i18n';
import { renderEnvironmentSettingsSection } from '../../../shared/settings/EnvironmentSettingsSection';
import { renderHostnameCliPathSetting } from '../../../shared/settings/HostnameCliPathSetting';
import { renderNativeMcpSettingsSection } from '../../../shared/settings/NativeMcpSettingsSection';
import { renderProviderEnablementSetting } from '../../../shared/settings/ProviderEnablementSetting';
import {
  renderLastEnabledProviderWarning,
  renderProviderModelEnablementWarning,
} from '../../../shared/settings/ProviderModelEnablementWarning';
import {
  type ProviderModelPickerModel,
  type ProviderModelPickerState,
  renderProviderModelPicker,
} from '../../../shared/settings/ProviderModelPicker';
import { getHostnameKey } from '../../../utils/env';
import { normalizeConfiguredCliPath } from '../../../utils/path';
import type { GrokWorkspaceServices } from '../app/GrokWorkspaceServices';
import type { GrokDiscoveredModel } from '../models';
import {
  clearCurrentGrokCatalog,
  getGrokProviderSettings,
  getOrderedGrokVisibleModelIds,
  normalizeGrokVisibleModels,
  updateGrokProviderSettings,
  updateGrokVisibleModels,
} from '../settings';

const GROK_PROVIDER_ID = 'grok' as const;

export const grokSettingsTabRenderer: ProviderSettingsTabRenderer = {
  render(container, context) {
    const settingsBag = context.plugin.settings as unknown as Record<string, unknown>;
    const hostnameKey = getHostnameKey();
    const workspace = getGrokWorkspaceServices();

    const refreshModelCatalog = async (): Promise<'empty' | 'failed' | 'loaded'> => {
      const result = await workspace.refreshModelCatalog();
      if (result.diagnostics) {
        new Notice(`Grok model discovery failed: ${result.diagnostics}`);
        return 'failed';
      }
      modelWarning.context.notifyProviderModelOptionsChanged(GROK_PROVIDER_ID);
      return (getGrokProviderSettings(settingsBag).currentCatalog?.models.length ?? 0) > 0
        ? 'loaded'
        : 'empty';
    };

    new Setting(container).setName('Setup').setHeading();

    renderProviderEnablementSetting({
      container,
      description: t('settings.providerEnablement.desc', { provider: 'Grok' }),
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
    });

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

    renderHostnameCliPathSetting({
      container,
      description: 'Optional absolute path to the Grok CLI for this computer. Leave empty to prefer known installs, then `grok` from PATH.',
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
          clearCurrentGrokCatalog(settings);
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
      validate: validateCliPath,
    });

    new Setting(container).setName('Models').setHeading();
    renderGrokModelPicker(container, modelWarning.context, settingsBag, refreshModelCatalog);

    new Setting(container).setName(t('settings.agentSkills.sectionTitle')).setHeading();
    context.renderAgentSkillSettings(container, GROK_PROVIDER_ID);

    new Setting(container).setName('Commands').setHeading();
    context.renderHiddenProviderCommandSetting(container, GROK_PROVIDER_ID, {
      name: 'Hidden Grok commands',
      desc: 'Hide runtime commands advertised by Grok from the command dropdown. Enter names without the leading slash, one per line.',
      placeholder: 'compact\nreview',
    });

    renderNativeMcpSettingsSection(container, {
      descriptionAfterCommand: ' and they will be available in Claudian. ',
      descriptionBeforeCommand: 'Grok Build manages MCP servers through its own CLI. Configure them with ',
      documentationLabel: 'Learn more',
      documentationUrl: 'https://docs.x.ai/build/features/mcp-servers',
      heading: t('settings.mcpServers.name'),
      setupCommand: 'grok mcp add',
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
  },
};

function renderGrokModelPicker(
  container: HTMLElement,
  context: ProviderSettingsTabRendererContext,
  settingsBag: Record<string, unknown>,
  loadCatalog: () => Promise<'empty' | 'failed' | 'loaded'>,
): void {
  const getState = (): ProviderModelPickerState => {
    const settings = getGrokProviderSettings(settingsBag);
    const catalogModels = settings.currentCatalog?.models ?? [];
    const selectedIds = getOrderedGrokVisibleModelIds(settings);
    return {
      aliases: settings.modelAliases,
      discoveredCount: catalogModels.length,
      models: buildGrokPickerModels(catalogModels, selectedIds),
      selectedIds,
    };
  };

  renderProviderModelPicker({
    checkCatalogFreshnessWhenCached: true,
    container,
    emptyCatalogText: 'No Grok models discovered yet. Run `grok login` if needed, then click Discover.',
    failedCatalogText: 'Could not load the Grok model catalog. Check the CLI path, account login, and custom-model environment, then try again.',
    getState,
    initiallyOpen: (getGrokProviderSettings(settingsBag).currentCatalog?.models.length ?? 0) === 0,
    loadCatalog: async () => loadCatalog(),
    loadingCatalogText: 'Loading the Grok model catalog...',
    modifier: 'grok',
    async onAliasesChange(modelAliases) {
      await context.plugin.mutateSettings((settings) => {
        updateGrokProviderSettings(settings, { modelAliases });
      });
      context.notifyProviderModelOptionsChanged(GROK_PROVIDER_ID);
    },
    async onSelectedIdsChange(selectedIds) {
      const current = getGrokProviderSettings(settingsBag);
      const models = current.currentCatalog?.models ?? [];
      const allowedIds = new Set(models.map(model => model.rawId));
      const normalized = normalizeGrokVisibleModels(selectedIds, allowedIds, models.length > 0);
      const nextVisibleModels = normalized;
      if (sameOptionalList(current.visibleModels, nextVisibleModels)) {
        return;
      }
      await context.plugin.mutateSettings((settings) => {
        updateGrokVisibleModels(settings, nextVisibleModels);
      });
      context.notifyProviderModelOptionsChanged(GROK_PROVIDER_ID);
    },
    providerName: 'Grok',
    searchPlaceholder: 'Filter by model name, description, or alias ID...',
  });
}

function buildGrokPickerModels(
  catalogModels: GrokDiscoveredModel[],
  selectedIds: string[],
): ProviderModelPickerModel[] {
  const models: ProviderModelPickerModel[] = catalogModels.map(model => ({
    description: model.description,
    id: model.rawId,
    isAvailable: true,
    name: model.displayName,
  }));
  const catalogIds = new Set(catalogModels.map(model => model.rawId));
  for (const rawId of selectedIds) {
    if (catalogIds.has(rawId)) {
      continue;
    }
    models.push({
      description: 'Selected model',
      id: rawId,
      isAvailable: false,
      name: rawId,
      unavailableMessage: 'Not currently reported by Grok',
    });
  }
  return models;
}

function sameOptionalList(left: string[] | null, right: string[] | null): boolean {
  if (left === null || right === null) {
    return left === right;
  }
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function validateCliPath(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  const expandedPath = normalizeConfiguredCliPath(trimmed);
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
