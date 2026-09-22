import * as fs from 'fs';
import { Setting } from 'obsidian';

import { probeCliInstallation } from '@/core/providers/cli/CliInstallationProbe';
import { getRuntimeEnvironmentVariables } from '@/core/providers/providerEnvironment';
import type { ProviderCliResolver } from '@/core/providers/types';
import { OPENCODE_PROVIDER_ICON } from '@/shared/icons';
import { renderCliInstallationSetting } from '@/shared/settings/CliInstallationSetting';

import { ProviderSettingsCoordinator } from '../../../core/providers/ProviderSettingsCoordinator';
import type {
  ProviderSettingsTabRenderer,
  ProviderSettingsTabRendererContext,
} from '../../../core/providers/types';
import { t } from '../../../i18n/i18n';
import { renderEnvironmentSettingsSection } from '../../../shared/settings/EnvironmentSettingsSection';
import type { ProviderEnablementSettingOptions } from '../../../shared/settings/ProviderEnablementSetting';
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
import { clearOpencodeDiscoveryState } from '../discoveryState';
import { sameStringList } from '../internal/compareCollections';
import type { OpencodeMetadataService } from '../metadata/OpencodeMetadataService';
import {
  buildOpencodeBaseModels,
  encodeOpencodeModelId,
  type OpencodeDiscoveredModel,
  splitOpencodeModelLabel,
} from '../models';
import {
  getOpencodeProviderSettings,
  normalizeOpencodeVisibleModels,
  updateOpencodeProviderSettings,
} from '../settings';
import { renderOpencodeMigrationNotice } from './OpencodeMigrationNotice';

export function createOpencodeSettingsTabRenderer(
  opencodeWorkspace: { cliResolver: Pick<ProviderCliResolver, 'reset'>; metadataService: Pick<OpencodeMetadataService, 'loadCatalog' | 'warmModelMetadata'>; },
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

      renderCliInstallationSetting({
        cliName: 'OpenCode CLI',
        icon: OPENCODE_PROVIDER_ICON,
        inspect: async () => {
          const settings = context.plugin.settings as unknown as Record<string, unknown>;
          const config = getOpencodeProviderSettings(settings);
          const installation = await probeCliInstallation({
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
              clearOpencodeDiscoveryState(settings);
            },
            () => opencodeWorkspace?.cliResolver?.reset(),
          );
        },
        placeholder: process.platform === 'win32'
          ? 'C:\\Users\\you\\AppData\\Roaming\\npm\\opencode.cmd'
          : '/usr/local/bin/opencode',
        validate: validateCliPath,
      });

      new Setting(container).setName('Models').setHeading();
      renderOpencodeModelPicker(container, modelWarning.context, settingsBag, opencodeWorkspace.metadataService);

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
    },
  };
}

function renderOpencodeModelPicker(
  container: HTMLElement,
  context: ProviderSettingsTabRendererContext,
  settingsBag: Record<string, unknown>,
  metadataService: Pick<OpencodeMetadataService, 'loadCatalog' | 'warmModelMetadata'>,
): void {
  const getState = (): ProviderModelPickerState => {
    const current = getOpencodeProviderSettings(settingsBag);
    return {
      aliases: current.modelAliases,
      discoveredCount: current.discoveredModels.length,
      models: buildOpencodePickerModels(current.discoveredModels, current.visibleModels),
      selectedIds: current.visibleModels,
    };
  };

  const warmModelMetadata = async (rawId: string): Promise<void> => {
    try {
      if (
        await metadataService.warmModelMetadata(encodeOpencodeModelId(rawId))
      ) {
        context.notifyProviderModelOptionsChanged('opencode');
      }
    } catch {
      // Metadata warmup is opportunistic; the first chat turn can still discover it.
    }
  };

  renderProviderModelPicker({
    container,
    emptyCatalogText: 'Start OpenCode once to load its model catalog. Claudian will then let you pick visible models.',
    failedCatalogText: 'Could not load the OpenCode model catalog. Check the CLI path and login state, then try again.',
    getState,
    async loadCatalog() {
      try {
        const loaded = await metadataService.loadCatalog();
        const discoveredCount = getOpencodeProviderSettings(settingsBag).discoveredModels.length;
        if (!loaded) {
          return 'failed';
        }
        if (discoveredCount > 0) {
          context.notifyProviderModelOptionsChanged('opencode');
          return 'loaded';
        }
        return 'empty';
      } catch {
        return 'failed';
      }
    },
    loadCatalogOnRender: true,
    loadingCatalogText: 'Loading OpenCode model catalog...',
    modifier: 'opencode',
    async onAliasesChange(modelAliases) {
      await context.plugin.mutateSettings((settings) => {
        updateOpencodeProviderSettings(settings, { modelAliases });
      });
      context.notifyProviderModelOptionsChanged('opencode');
    },
    onModelSelected: async (model) => warmModelMetadata(model.id),
    async onSelectedIdsChange(visibleModels) {
      const current = getOpencodeProviderSettings(settingsBag);
      const normalized = normalizeOpencodeVisibleModels(visibleModels, current.discoveredModels);
      if (sameStringList(current.visibleModels, normalized)) {
        return;
      }

      await context.plugin.mutateSettings((settings) => {
        updateOpencodeProviderSettings(settings, { visibleModels: normalized });
      });
      context.notifyProviderModelOptionsChanged('opencode');
    },
    providerName: 'OpenCode',
  });
}

function validateCliPath(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  const expandedPath = normalizeConfiguredCliPath(trimmed);
  if (!fs.existsSync(expandedPath)) {
    return 'Path does not exist';
  }
  if (!fs.statSync(expandedPath).isFile()) {
    return 'Path must point to a file';
  }
  return null;
}

function buildOpencodePickerModels(
  discoveredModels: OpencodeDiscoveredModel[],
  visibleModels: string[],
): ProviderModelPickerModel[] {
  const models: ProviderModelPickerModel[] = [];
  const discoveredIds = new Set<string>();

  for (const model of buildOpencodeBaseModels(discoveredModels)) {
    const { modelLabel, providerLabel } = splitOpencodeModelLabel(model.label || model.rawId);
    discoveredIds.add(model.rawId);
    models.push({
      description: model.description ?? '',
      id: model.rawId,
      isAvailable: true,
      name: modelLabel,
      providerKey: providerLabel.toLowerCase(),
      providerLabel,
    });
  }

  for (const rawId of visibleModels) {
    if (discoveredIds.has(rawId)) {
      continue;
    }

    const { modelLabel, providerLabel } = splitOpencodeModelLabel(rawId);
    models.push({
      id: rawId,
      isAvailable: false,
      name: modelLabel,
      providerKey: providerLabel.toLowerCase(),
      providerLabel,
      unavailableMessage: 'Not currently reported by OpenCode',
    });
  }

  return models.sort((left, right) => {
    const providerCmp = (left.providerLabel ?? '').localeCompare(right.providerLabel ?? '');
    if (providerCmp !== 0) {
      return providerCmp;
    }
    return left.name.localeCompare(right.name);
  });
}
