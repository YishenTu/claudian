import type { ProviderHost } from '@/core/providers/ProviderHost';
import type {
  ACPSessionConfigOption,
  ACPSessionModelState,
  ACPSessionModeState,
} from '@/providers/acp';
import {
  extractACPSessionModelState,
  extractACPSessionModeState,
  extractACPSessionThoughtLevelState,
} from '@/providers/acp';

import {
  normalizeOpencodeDiscoveredModels,
  normalizeOpencodeModelVariants,
  resolveOpencodeBaseModelRawId,
} from '../models';
import { normalizeOpencodeAvailableModes } from '../modes';
import {
  getOpencodeProviderSettings,
  updateOpencodeProviderSettings,
} from '../settings';

export interface OpencodeMetadataProjectionInput {
  readonly configOptions?: ACPSessionConfigOption[] | null;
  readonly models?: ACPSessionModelState | null;
  readonly modes?: ACPSessionModeState | null;
  readonly selectedRawModelId?: string | null;
  readonly reasoningMetadataResolved?: boolean;
}

export async function projectOpencodeMetadata(
  plugin: ProviderHost,
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
  const modeState = extractACPSessionModeState({
    configOptions: input.configOptions,
    modes: input.modes,
  });
  const availableModes = normalizeOpencodeAvailableModes(
    modeState.availableModes,
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
  const hasModes = input.modes != null || modeState.currentModeId !== null || availableModes.length > 0;
  const hasThinking = rawModelId !== null
    && (thoughtState.configId !== null || input.reasoningMetadataResolved === true);
  const hasUpdate = hasModels || hasModes || hasThinking;
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
      ...(hasModes ? { availableModes } : {}),
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
