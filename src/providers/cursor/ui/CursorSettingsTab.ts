import * as fs from 'node:fs';

import { Notice, Setting } from 'obsidian';

import { deriveProviderModelCatalogStatus } from '../../../core/providers/modelCatalog';
import { assessProviderReadiness } from '../../../core/providers/ProviderReadiness';
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
import { renderProviderReadinessPanel } from '../../../shared/settings/ProviderReadinessPanel';
import { getHostnameKey } from '../../../utils/env';
import { expandHomePath } from '../../../utils/path';
import { maybeGetCursorWorkspaceServices } from '../app/CursorWorkspaceServices';
import { normalizeCursorVisibleModels } from '../models';
import {
  getCursorProviderSettings,
  updateCursorProviderSettings,
} from '../settings';

export const cursorSettingsTabRenderer: ProviderSettingsTabRenderer = {
  render(container, context) {
    const settings = context.plugin.settings as unknown as Record<string, unknown>;
    const workspace = maybeGetCursorWorkspaceServices();
    const hostnameKey = getHostnameKey();
    const readinessPanel = renderProviderReadinessPanel({
      container,
      providerName: 'Cursor',
      async getSnapshot() {
        const provider = getCursorProviderSettings(settings);
        return assessProviderReadiness({
          cliPath: typeof context.plugin.getResolvedProviderCliPath === 'function'
            ? await context.plugin.getResolvedProviderCliPath('cursor')
            : null,
          discoveredModelCount: provider.discoveredModels.length,
          enabled: provider.enabled,
          selectedModelCount: provider.visibleModels.length,
        });
      },
      async onRefresh() {
        const result = await workspace?.refreshModelCatalog?.();
        if (result?.diagnostics) {
          new Notice(t('settings.cursor.discoveryFailed', { error: result.diagnostics }));
        }
        context.notifyProviderModelOptionsChanged('cursor');
      },
    });
    new Setting(container).setName(t('settings.cursor.setup')).setHeading();
    renderProviderEnablementSetting({
      container,
      description: t('settings.cursor.enableDesc'),
      getValue: () => getCursorProviderSettings(settings).enabled,
      name: t('settings.cursor.enable'),
      onChange: async enabled => {
        await context.plugin.mutateSettings(target => {
          updateCursorProviderSettings(target, { enabled });
        });
        await readinessPanel.refresh();
        context.notifyProviderModelOptionsChanged('cursor');
      },
    });
    renderHostnameCliPathSetting({
      container,
      description: t('settings.cursor.cliPathDesc'),
      getValue: () => getCursorProviderSettings(settings).cliPathsByHost[hostnameKey] || '',
      name: t('settings.cursor.cliPath'),
      onChange: async value => {
        const provider = getCursorProviderSettings(settings);
        const cliPathsByHost = { ...provider.cliPathsByHost };
        if (value) cliPathsByHost[hostnameKey] = value;
        else delete cliPathsByHost[hostnameKey];
        await context.plugin.applyProviderRuntimeSettings(
          ['cursor'],
          target => {
            updateCursorProviderSettings(target, { cliPathsByHost, discoveredModels: [] });
          },
          () => workspace?.cliResolver.reset(),
        );
        context.notifyProviderModelOptionsChanged('cursor');
      },
      placeholder: process.platform === 'win32'
        ? 'C:\\Users\\you\\.local\\bin\\agent.exe'
        : '/Users/you/.local/bin/agent',
      validate: validateCliPath,
    });
    new Setting(container).setName(t('settings.cursor.models')).setHeading();
    renderCursorModelPicker(container, context, settings);
  },
};

function renderCursorModelPicker(
  container: HTMLElement,
  context: Parameters<ProviderSettingsTabRenderer['render']>[1],
  settings: Record<string, unknown>,
): void {
  const getState = (): ProviderModelPickerState => {
    const provider = getCursorProviderSettings(settings);
    return {
      aliases: {},
      catalogRefreshedAt: provider.catalogTimestamp || undefined,
      catalogStatus: deriveProviderModelCatalogStatus({
        modelCount: provider.discoveredModels.length,
        refreshedAt: provider.catalogTimestamp || undefined,
      }),
      defaultModelId: provider.visibleModels[0],
      discoveredCount: provider.discoveredModels.length,
      models: provider.discoveredModels.map(toPickerModel),
      selectionMode: 'explicit',
      selectedIds: provider.visibleModels,
    };
  };
  renderProviderModelPicker({
    container,
    emptyCatalogText: t('settings.cursor.noModels'),
    failedCatalogText: t('settings.cursor.catalogFailed'),
    getState,
    async loadCatalog() {
      const result = await maybeGetCursorWorkspaceServices()?.refreshModelCatalog?.();
      if (!result || result.diagnostics) {
        new Notice(t('settings.cursor.discoveryFailed', {
          error: result?.diagnostics ?? t('settings.cursor.workspaceNotInitialized'),
        }));
        return 'failed';
      }
      context.notifyProviderModelOptionsChanged('cursor');
      return getCursorProviderSettings(settings).discoveredModels.length > 0 ? 'loaded' : 'empty';
    },
    loadingCatalogText: t('settings.cursor.loadingModels'),
    modifier: 'cursor',
    onAliasesChange: async () => undefined,
    async onSelectedIdsChange(visibleModels) {
      await context.plugin.mutateSettings(target => {
        const provider = getCursorProviderSettings(target);
        updateCursorProviderSettings(target, {
          visibleModels: normalizeCursorVisibleModels(visibleModels, provider.discoveredModels),
        });
      });
      context.notifyProviderModelOptionsChanged('cursor');
    },
    providerName: 'Cursor',
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
  model: ReturnType<typeof getCursorProviderSettings>['discoveredModels'][number],
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
