import type { ProviderRuntimeHost } from '@/core/providers/ProviderRuntimeHost';
import type {
  ACPSessionConfigOption,
  ACPSessionModelState,
} from '@/providers/acp';
import {
  extractACPSessionModelState,
  extractACPSessionThoughtLevelState,
} from '@/providers/acp';

import { decodeOpencodeConfig, updateOpencodeConfig } from '../config';
import {
  normalizeOpencodeDiscoveredModels,
  normalizeOpencodeModelVariants,
  resolveOpencodeBaseModelRawId,
} from '../models';

export interface OpencodeMetadataProjectionInput {
  readonly configOptions?: ACPSessionConfigOption[] | null;
  readonly models?: ACPSessionModelState | null;
  readonly selectedRawModelId?: string | null;
  readonly reasoningMetadataResolved?: boolean;
}

export async function projectOpencodeMetadata(
  host: ProviderRuntimeHost,
  input: OpencodeMetadataProjectionInput,
  signal?: AbortSignal,
): Promise<boolean> {
  const modelState = extractACPSessionModelState({
    configOptions: input.configOptions,
    models: input.models,
  });
  const discoveredModels = normalizeOpencodeDiscoveredModels(
    modelState.availableModels.map((model) => ({
      ...(model.description ? { description: model.description } : {}),
      label: model.name,
      rawId: model.id,
    })),
  );
  const thoughtState = extractACPSessionThoughtLevelState({
    configOptions: input.configOptions,
  });
  const thinkingOptions = normalizeOpencodeModelVariants(
    thoughtState.availableLevels.map((level) => ({
      ...(level.description ? { description: level.description } : {}),
      label: level.name,
      value: level.id,
    })),
  );
  const rawModelId = input.selectedRawModelId
    ?? modelState.currentModelId
    ?? null;
  // Omitted metadata is a partial update; a supplied empty snapshot clears it.
  // ACP selectors retain currentValue (including '') even when their options are empty.
  const hasModels = input.models != null || modelState.currentModelId !== null || discoveredModels.length > 0;
  const hasThinking = rawModelId !== null
    && (thoughtState.configId !== null || input.reasoningMetadataResolved === true);
  const hasUpdate = hasModels || hasThinking;
  if (!hasUpdate) return false;

  const published = await host.updateConfig((config) => {
    if (signal?.aborted) return false;
    const current = decodeOpencodeConfig(config);
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
    updateOpencodeConfig(config, {
      ...(hasModels ? { discoveredModels } : {}),
      ...(baseRawModelId && hasThinking
        ? { thinkingOptionsByModel: nextThinking }
        : {}),
    });
    return true;
  });
  if (!published || signal?.aborted) return false;
  host.notifyChatOptionsChanged();
  return true;
}
