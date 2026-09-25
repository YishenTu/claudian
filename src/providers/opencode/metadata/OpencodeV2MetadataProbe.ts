import { formatReasoningValueLabel } from '@/core/providers/reasoning';
import { normalizeACPAvailableCommands } from '@/providers/acp';

import { pollOpencodeUntil } from '../http/OpencodeHTTPClient';
import type { OpencodeServerLease } from '../http/OpencodeServerService';
import type {
  OpencodeMetadataCatalogResult,
  OpencodeMetadataProbe,
  OpencodeMetadataWarmResult,
} from './OpencodeMetadataService';

interface NativeModel {
  id: string;
  providerID: string;
  name: string;
  variants: string[];
}

/** V2 catalog reads share native credentials without creating a native session. */
export class OpencodeV2MetadataProbe implements OpencodeMetadataProbe {
  constructor(private readonly client: OpencodeServerLease) {}

  async loadCatalog(signal?: AbortSignal): Promise<OpencodeMetadataCatalogResult> {
    const ownedSignal = this.client.signal(signal);
    const models = await this.loadModels(ownedSignal);
    const commands = await this.read('command', ownedSignal);
    return {
      commands: normalizeACPAvailableCommands(commands.filter(isNamedRecord).map(command => ({
        name: command.name,
        ...(typeof command.description === 'string' ? { description: command.description } : {}),
      }))),
      models: modelState(models),
    };
  }

  async warmModel(rawModelId: string, signal?: AbortSignal): Promise<OpencodeMetadataWarmResult> {
    const models = await this.loadModels(this.client.signal(signal), rawModelId);
    const model = models.find(model => `${model.providerID}/${model.id}` === rawModelId);
    if (!model) throw new Error('OpenCode model is no longer available. Refresh the model catalog.');
    const variants = model.variants.length > 0 ? [...new Set([...model.variants, 'default'])] : [];
    return {
      rawModelId,
      models: modelState(models),
      configOptions: [{
        id: 'effort', name: 'Effort', category: 'thought_level', type: 'select', currentValue: 'default',
        options: variants.map(value => ({ value, name: formatReasoningValueLabel(value) })),
      }],
    };
  }

  async dispose(): Promise<void> { await this.client.dispose(); }

  private async loadModels(signal: AbortSignal, rawModelId?: string): Promise<NativeModel[]> {
    await this.client.waitForActivation(signal);
    // Older versions and background discovery can still need polling or a later refresh.
    return pollOpencodeUntil(async () => (await this.read('model', signal)).filter(isNamedRecord).flatMap(model => {
      if (model.enabled !== true || typeof model.id !== 'string' || typeof model.providerID !== 'string') return [];
      return [{
        id: model.id, providerID: model.providerID, name: model.name,
        variants: Array.isArray(model.variants)
          ? model.variants.filter(isRecord).flatMap(variant => typeof variant.id === 'string' ? [variant.id] : [])
          : [],
      }];
    }), models => rawModelId
      ? models.some(model => `${model.providerID}/${model.id}` === rawModelId)
      : models.length > 0, 5_000, signal);
  }

  private async read(resource: 'model' | 'command', signal: AbortSignal): Promise<unknown[]> {
    const result = await this.client.request(`/api/${resource}`, { signal });
    if (!isRecord(result) || !Array.isArray(result.data)) throw new Error('Invalid OpenCode catalog response.');
    return result.data as unknown[];
  }
}

function modelState(models: NativeModel[]): NonNullable<OpencodeMetadataCatalogResult['models']> {
  return {
    currentModelId: '',
    availableModels: models.map(model => ({ modelId: `${model.providerID}/${model.id}`, name: `${model.providerID}/${model.name}` })),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isNamedRecord(value: unknown): value is Record<string, unknown> & { name: string } {
  return isRecord(value) && typeof value.name === 'string';
}
