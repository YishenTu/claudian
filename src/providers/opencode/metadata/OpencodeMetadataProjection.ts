import type { ProviderHost } from '@/core/providers/ProviderHost';

import type { OpencodeNativeModel } from '../http/OpencodeNativeModelCatalog';
import {
  normalizeOpencodeDiscoveredModels,
  normalizeOpencodeModelVariants,
  resolveOpencodeBaseModelRawId,
} from '../models';
import {
  getOpencodeProviderSettings,
  updateOpencodeProviderSettings,
} from '../settings';

/** A partial update: omitted metadata is kept, while a supplied empty list clears it. */
export interface OpencodeMetadataProjectionInput {
  readonly models?: readonly OpencodeNativeModel[];
  /** The model whose thinking levels this update carries. */
  readonly selectedRawModelId?: string | null;
  /** The selected model's resolved thinking levels; empty means it has none. */
  readonly thinkingLevels?: readonly string[];
}

export async function projectOpencodeMetadata(
  plugin: ProviderHost,
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

  let published = false;
  await plugin.mutateSettingsConditionally((settings) => {
    if (signal?.aborted) return false;
    const current = getOpencodeProviderSettings(settings);
    const baseRawModelId = rawModelId
      ? resolveOpencodeBaseModelRawId(
        rawModelId,
        discoveredModels.length > 0 ? discoveredModels : current.discoveredModels,
      )
      : null;
    const nextThinking = { ...current.thinkingOptionsByModel };
    if (baseRawModelId && hasThinking) {
      nextThinking[baseRawModelId] = thinkingOptions;
    }
    updateOpencodeProviderSettings(settings, {
      ...(hasModels ? { discoveredModels } : {}),
      ...(baseRawModelId && hasThinking
        ? { thinkingOptionsByModel: nextThinking }
        : {}),
    });
    published = true;
    return true;
  });
  if (!published || signal?.aborted) return false;
  plugin.notifyProviderChatOptionsChanged('opencode');
  return true;
}
