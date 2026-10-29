import type { ProviderRuntimeHost } from '@/core/providers/ProviderRuntimeHost';

import { decodeOpencodeConfig, updateOpencodeConfig } from '../config';
import type { OpencodeNativeModel } from '../http/OpencodeNativeModelCatalog';
import {
  normalizeOpencodeDiscoveredModels,
  normalizeOpencodeModelVariants,
} from '../models';

/** A partial update: omitted metadata is kept, while a supplied empty list clears it. */
export interface OpencodeMetadataProjectionInput {
  readonly models?: readonly OpencodeNativeModel[];
  /** The model whose thinking levels this update carries. */
  readonly selectedRawModelId?: string | null;
  /** The selected model's resolved thinking levels; empty means it has none. */
  readonly thinkingLevels?: readonly string[];
}

export async function projectOpencodeMetadata(
  host: ProviderRuntimeHost,
  input: OpencodeMetadataProjectionInput,
  signal?: AbortSignal,
): Promise<boolean> {
  const discoveredModels = normalizeOpencodeDiscoveredModels(
    (input.models ?? []).map(({ label, rawId }) => ({ label, rawId })),
  );
  const thinkingOptions = normalizeOpencodeModelVariants(
    (input.thinkingLevels ?? []).map(value => ({ value })),
  );
  const rawModelId = input.selectedRawModelId ?? null;
  const hasModels = input.models !== undefined;
  const hasThinking = rawModelId !== null && input.thinkingLevels !== undefined;
  const hasUpdate = hasModels || hasThinking;
  if (!hasUpdate) return false;

  const published = await host.updateConfig((config) => {
    if (signal?.aborted) return false;
    const current = decodeOpencodeConfig(config);
    const nextThinking = { ...current.thinkingOptionsByModel };
    if (rawModelId && hasThinking) {
      Object.defineProperty(nextThinking, rawModelId, { value: thinkingOptions, enumerable: true, writable: true, configurable: true });
    }
    updateOpencodeConfig(config, {
      ...(hasModels ? { discoveredModels } : {}),
      ...(rawModelId && hasThinking
        ? { thinkingOptionsByModel: nextThinking }
        : {}),
    });
    return true;
  });
  if (!published || signal?.aborted) return false;
  host.notifyChatOptionsChanged();
  return true;
}
