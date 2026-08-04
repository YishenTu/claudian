import * as fs from 'node:fs';

import { Notice, Setting } from 'obsidian';

import type {
  ProviderSettingsTabRenderer,
} from '../../../core/providers/types';
import { t } from '../../../i18n/i18n';
import { renderHostnameCliPathSetting } from '../../../shared/settings/HostnameCliPathSetting';
import { renderProviderEnablementSetting } from '../../../shared/settings/ProviderEnablementSetting';
import {
  type ProviderModelPickerModel,
  type ProviderModelPickerState,
  renderProviderModelPicker,
} from '../../../shared/settings/ProviderModelPicker';
import { getHostnameKey } from '../../../utils/env';
import { expandHomePath } from '../../../utils/path';
import { maybeGetOmpWorkspaceServices } from '../app/OmpWorkspaceServices';
import { normalizeOmpVisibleModels } from '../models';
import {
  getOmpProviderSettings,
  updateOmpProviderSettings,
} from '../settings';

export const ompSettingsTabRenderer: ProviderSettingsTabRenderer = {
  render(container, context) {
    const settings = context.plugin.settings as unknown as Record<string, unknown>;
    const workspace = maybeGetOmpWorkspaceServices();
    const hostnameKey = getHostnameKey();
    new Setting(container).setName(t('settings.omp.setup')).setHeading();
    renderProviderEnablementSetting({
      container,
      description: t('settings.omp.enableDesc'),
      getValue: () => getOmpProviderSettings(settings).enabled,
      name: t('settings.omp.enable'),
      onChange: async enabled => {
        await context.plugin.mutateSettings(target => {
          updateOmpProviderSettings(target, { enabled });
        });
        context.notifyProviderModelOptionsChanged('omp');
      },
    });
    renderHostnameCliPathSetting({
      container,
      description: t('settings.omp.cliPathDesc'),
      getValue: () => getOmpProviderSettings(settings).cliPathsByHost[hostnameKey] || '',
      name: t('settings.omp.cliPath'),
      onChange: async value => {
        const provider = getOmpProviderSettings(settings);
        const cliPathsByHost = { ...provider.cliPathsByHost };
        if (value) cliPathsByHost[hostnameKey] = value;
        else delete cliPathsByHost[hostnameKey];
        await context.plugin.applyProviderRuntimeSettings(
          ['omp'],
          target => {
            updateOmpProviderSettings(target, { cliPathsByHost, discoveredModels: [] });
          },
          () => workspace?.cliResolver.reset(),
        );
        context.notifyProviderModelOptionsChanged('omp');
      },
      placeholder: process.platform === 'win32'
        ? 'C:\\Users\\you\\.bun\\bin\\omp.exe'
        : '/Users/you/.bun/bin/omp',
      validate: validateCliPath,
    });
    new Setting(container).setName(t('settings.omp.models')).setHeading();
    renderOmpModelPicker(container, context, settings);
  },
};

function renderOmpModelPicker(
  container: HTMLElement,
  context: Parameters<ProviderSettingsTabRenderer['render']>[1],
  settings: Record<string, unknown>,
): void {
  const getState = (): ProviderModelPickerState => {
    const provider = getOmpProviderSettings(settings);
    return {
      aliases: {},
      discoveredCount: provider.discoveredModels.length,
      models: provider.discoveredModels.map(toPickerModel),
      selectedIds: provider.visibleModels,
    };
  };
  renderProviderModelPicker({
    container,
    emptyCatalogText: t('settings.omp.noModels'),
    failedCatalogText: t('settings.omp.catalogFailed'),
    getState,
    async loadCatalog() {
      const result = await maybeGetOmpWorkspaceServices()?.refreshModelCatalog?.();
      if (!result || result.diagnostics) {
        new Notice(t('settings.omp.discoveryFailed', {
          error: result?.diagnostics ?? t('settings.omp.workspaceNotInitialized'),
        }));
        return 'failed';
      }
      context.notifyProviderModelOptionsChanged('omp');
      return getOmpProviderSettings(settings).discoveredModels.length > 0 ? 'loaded' : 'empty';
    },
    loadingCatalogText: t('settings.omp.loadingModels'),
    modifier: 'omp',
    onAliasesChange: async () => undefined,
    async onSelectedIdsChange(visibleModels) {
      await context.plugin.mutateSettings(target => {
        const provider = getOmpProviderSettings(target);
        updateOmpProviderSettings(target, {
          visibleModels: normalizeOmpVisibleModels(visibleModels, provider.discoveredModels),
        });
      });
      context.notifyProviderModelOptionsChanged('omp');
    },
    providerName: 'OMP',
  });
}

function validateCliPath(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const expandedPath = expandHomePath(trimmed);
  if (!fs.existsSync(expandedPath)) return 'Path does not exist';
  return fs.statSync(expandedPath).isFile() ? null : 'Path must point to a file';
}

function toPickerModel(
  model: ReturnType<typeof getOmpProviderSettings>['discoveredModels'][number],
): ProviderModelPickerModel {
  const [providerKey, ...modelIdParts] = model.rawId.split('/');
  const providerLabel = providerKey ? formatProviderLabel(providerKey) : undefined;
  return {
    description: model.description,
    id: model.rawId,
    isAvailable: true,
    name: model.label || modelIdParts.join('/') || model.rawId,
    ...(providerKey && providerLabel ? { providerKey, providerLabel } : {}),
  };
}

function formatProviderLabel(providerKey: string): string {
  return providerKey
    .split(/[-_]/u)
    .map(part => part ? `${part[0].toUpperCase()}${part.slice(1)}` : part)
    .join(' ');
}
