import { OPENCODE_DEFAULT_THINKING_LEVEL } from '../models';
import { isRecord, pollOpencodeUntil } from './OpencodeHTTPClient';
import type { OpencodeServerLease } from './OpencodeServerService';

/** One enabled entry of OpenCode's native `/api/model` catalog. */
export interface OpencodeNativeModel {
  /** Selection ID: `<providerID>/<id>`. */
  readonly rawId: string;
  readonly providerID: string;
  readonly id: string;
  /** `<provider name>/<model name>`, falling back to the native IDs. */
  readonly label: string;
  readonly variants: readonly string[];
  /** Zero when the native catalog reports no context limit. */
  readonly contextWindow: number;
}

/**
 * Reads the enabled native catalog once the server's account state activates.
 * Background discovery can still add models, so reads poll until `rawModelId`
 * (or any model) appears; the last read is returned after the deadline.
 */
export async function loadOpencodeNativeModels(
  client: Pick<OpencodeServerLease, 'request' | 'waitForActivation'>,
  signal: AbortSignal,
  rawModelId?: string,
): Promise<OpencodeNativeModel[]> {
  await client.waitForActivation(signal);
  const models = await pollOpencodeUntil(async () => {
    const result = await client.request('/api/model', { signal });
    if (!isRecord(result) || !Array.isArray(result.data)) throw new Error('Invalid OpenCode catalog response.');
    return parseOpencodeNativeModels(result.data);
  }, models => rawModelId
    ? models.some(model => model.rawId === rawModelId)
    : models.length > 0, 5_000, signal);
  // Provider names are optional on older servers and cannot contain the group separator.
  let providers: unknown[];
  try {
    const result = await client.request('/api/provider', { signal });
    providers = isRecord(result) && Array.isArray(result.data) ? result.data : [];
  } catch {
    signal.throwIfAborted();
    providers = [];
  }
  const names = new Map(providers.flatMap(provider => (
    isRecord(provider) && typeof provider.id === 'string' && typeof provider.name === 'string'
      && provider.name.trim() && !provider.name.includes('/')
      ? [[provider.id, provider.name.trim()] as const]
      : []
  )));
  return models.map(model => {
    const name = names.get(model.providerID);
    return name ? { ...model, label: `${name}/${model.label.slice(model.providerID.length + 1)}` } : model;
  });
}

function parseOpencodeNativeModels(data: readonly unknown[]): OpencodeNativeModel[] {
  return data.flatMap((model): OpencodeNativeModel[] => {
    if (!isRecord(model) || model.enabled !== true || typeof model.id !== 'string' || typeof model.providerID !== 'string') return [];
    const name = typeof model.name === 'string' ? model.name : model.id;
    const limit = isRecord(model.limit) ? model.limit.context : undefined;
    return [{
      rawId: `${model.providerID}/${model.id}`,
      providerID: model.providerID,
      id: model.id,
      label: `${model.providerID}/${name}`,
      variants: Array.isArray(model.variants)
        ? model.variants.flatMap(variant => isRecord(variant) && typeof variant.id === 'string' ? [variant.id] : [])
        : [],
      contextWindow: typeof limit === 'number' && Number.isFinite(limit) ? Math.max(0, limit) : 0,
    }];
  });
}

/** Thinking levels a model offers; `default` (no variant) joins any native variants. */
export function listOpencodeThinkingLevels(model: OpencodeNativeModel | undefined): string[] {
  return model && model.variants.length > 0
    ? [...new Set([...model.variants, OPENCODE_DEFAULT_THINKING_LEVEL])]
    : [];
}
