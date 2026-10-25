import { createConfigCatalogStore, ProviderModelCatalogController } from '@/core/providers/models/ProviderModelCatalog';
import { ProviderModelUnavailableError } from '@/core/providers/models/ProviderModelUnavailableError';
import type { ProviderRuntimeHost } from '@/core/providers/ProviderRuntimeHost';

import { decodeDeepSeekConfig, isDeepSeekModelSelectable, updateDeepSeekConfig } from '../config';
import { type DeepSeekModel, encodeDeepSeekModelId } from '../models';
import { isRecord } from '../remote/DeepSeekRemoteClient';

export function assertDeepSeekModelAvailable(
  host: Pick<ProviderRuntimeHost, 'config' | 'selection'>, requestedModel: string | undefined,
): void {
  const model = requestedModel ?? host.selection.model ?? '';
  const config = decodeDeepSeekConfig(host.config);
  if (!config.enabled || !isDeepSeekModelSelectable(config, model)) {
    throw new ProviderModelUnavailableError('DeepSeek Harness');
  }
}

export function createDeepSeekModels(host: ProviderRuntimeHost, discover: (signal: AbortSignal) => Promise<unknown>): ProviderModelCatalogController {
  return new ProviderModelCatalogController({
    providerName: 'DeepSeek Harness',
    store: createConfigCatalogStore(host, {
      update: (config, _selection, patch) => { updateDeepSeekConfig(config, patch); },
      read: config => {
        const current = decodeDeepSeekConfig(config);
        return { enabled: current.enabled, selectedIds: current.visibleModels, aliases: current.modelAliases,
          models: current.discoveredModels.map(model => ({ id: model.encodedId, name: model.label, description: model.description,
            providerKey: model.provider, providerLabel: model.provider, isAvailable: model.available !== false,
          })),
        };
      },
    }),
    discover: async signal => {
      const models = decodeCatalog(await discover(signal));
      await host.updateConfig(config => {
        if (signal.aborted) return false;
        const current = decodeDeepSeekConfig(config);
        const ids = new Set(models.map(model => model.encodedId));
        const missing = current.discoveredModels.filter(model => current.visibleModels.includes(model.encodedId) && !ids.has(model.encodedId))
          .map(model => ({ ...model, available: false }));
        updateDeepSeekConfig(config, { discoveredModels: [...models, ...missing] });
        return true;
      });
      if (signal.aborted) return { changed: false };
      host.notifyChatOptionsChanged();
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
