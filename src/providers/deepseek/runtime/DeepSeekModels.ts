import { ProviderModelCatalogController } from '@/core/providers/models/ProviderModelCatalog';
import { ProviderModelUnavailableError } from '@/core/providers/models/ProviderModelUnavailableError';
import type { ProviderHost } from '@/core/providers/ProviderHost';

import { type DeepSeekModel, encodeDeepSeekModelId } from '../models';
import { isRecord } from '../remote/DeepSeekRemoteClient';
import { getDeepSeekProviderSettings, updateDeepSeekProviderSettings } from '../settings';

export function assertDeepSeekModelAvailable(settings: Record<string, unknown>, requestedModel: string | undefined): void {
  const model = requestedModel ?? (typeof settings.model === 'string' ? settings.model : '');
  const config = getDeepSeekProviderSettings(settings);
  if (!config.enabled || !config.visibleModels.includes(model) || !config.discoveredModels.some(row => row.encodedId === model && row.available !== false)) {
    throw new ProviderModelUnavailableError('DeepSeek Harness');
  }
}

export function createDeepSeekModels(host: ProviderHost, discover: (signal: AbortSignal) => Promise<unknown>): ProviderModelCatalogController {
  return new ProviderModelCatalogController({
    providerId: 'deepseek', providerName: 'DeepSeek Harness', host, update: updateDeepSeekProviderSettings,
    read: (settings = host.settings) => {
      const current = getDeepSeekProviderSettings(settings);
      return { enabled: current.enabled, selectedIds: current.visibleModels, aliases: current.modelAliases,
        models: current.discoveredModels.map(model => ({ id: model.encodedId, name: model.label, description: model.description,
          providerKey: model.provider, providerLabel: model.provider, isAvailable: model.available !== false,
        })),
      };
    },
    discover: async signal => {
      const models = decodeCatalog(await discover(signal));
      await host.mutateSettingsConditionally(settings => {
        if (signal.aborted) return false;
        const current = getDeepSeekProviderSettings(settings);
        const ids = new Set(models.map(model => model.encodedId));
        const missing = current.discoveredModels.filter(model => current.visibleModels.includes(model.encodedId) && !ids.has(model.encodedId))
          .map(model => ({ ...model, available: false }));
        updateDeepSeekProviderSettings(settings, { discoveredModels: [...models, ...missing] });
        return true;
      });
      if (signal.aborted) return { changed: false };
      host.notifyProviderChatOptionsChanged('deepseek');
      return { changed: true };
    },
  });
}

function decodeCatalog(value: unknown): DeepSeekModel[] {
  if (!isRecord(value) || !Array.isArray(value.groups)) throw new Error('Malformed DeepSeek model catalog.');
  const models: DeepSeekModel[] = [];
  for (const group of value.groups) {
    if (!isRecord(group) || typeof group.id !== 'string' || !Array.isArray(group.models)) throw new Error('Malformed DeepSeek model group.');
    for (const native of group.models) {
      if (!isRecord(native) || typeof native.id !== 'string') throw new Error('Malformed DeepSeek model.');
      const reasoning = isRecord(native.reasoning) && Array.isArray(native.reasoning.efforts) ? native.reasoning.efforts : [];
      models.push({ encodedId: encodeDeepSeekModelId(group.id, native.id), provider: group.id, id: native.id,
        label: typeof native.name === 'string' ? native.name : native.id,
        description: typeof native.description === 'string' ? native.description : undefined,
        reasoning: reasoning.filter(isRecord).filter(effort => typeof effort.id === 'string').map(effort => ({ id: effort.id as string, name: typeof effort.name === 'string' ? effort.name : effort.id as string })),
        available: true,
      });
    }
  }
  return models;
}

