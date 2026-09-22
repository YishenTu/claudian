import { formatReasoningValueLabel } from '@/core/providers/reasoning';
import { normalizeAcpAvailableCommands } from '@/providers/acp';

import { OpencodeHttpClient } from '../http/OpencodeHttpClient';
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
  private readonly client: OpencodeHttpClient;

  constructor(cliPath: string, cwd: string, environment: NodeJS.ProcessEnv) {
    this.client = new OpencodeHttpClient(cliPath, cwd, environment);
  }

  async loadCatalog(signal?: AbortSignal): Promise<OpencodeMetadataCatalogResult> {
    const ownedSignal = this.client.signal(signal);
    const models = await this.loadModels(ownedSignal);
    const commands = await this.read('command', ownedSignal);
    return {
      commands: normalizeAcpAvailableCommands(commands.filter(isNamedRecord).map(command => ({
        name: command.name,
        ...(typeof command.description === 'string' ? { description: command.description } : {}),
      }))),
      models: modelState(models),
    };
  }

  async warmModel(rawModelId: string, signal?: AbortSignal): Promise<OpencodeMetadataWarmResult> {
    const models = await this.loadModels(this.client.signal(signal));
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

  private async loadModels(signal: AbortSignal): Promise<NativeModel[]> {
    // Like native ACP, wait for providers that initialize their catalog asynchronously.
    const deadline = Date.now() + 5_000;
    do {
      const rows = await this.read('model', signal);
      const models = rows.filter(isNamedRecord).flatMap(model => {
        if (model.enabled !== true || typeof model.id !== 'string' || typeof model.providerID !== 'string') return [];
        return [{
          id: model.id, providerID: model.providerID, name: model.name,
          variants: Array.isArray(model.variants)
            ? model.variants.filter(isRecord).flatMap(variant => typeof variant.id === 'string' ? [variant.id] : [])
            : [],
        }];
      });
      if (models.length > 0) return models;
      await delay(signal);
    } while (Date.now() < deadline);
    return [];
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

function delay(signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const onAbort = (): void => {
      window.clearTimeout(timer);
      reject(new Error('OpenCode catalog probe aborted.'));
    };
    const timer = window.setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, 25);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
