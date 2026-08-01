import type { ProviderHost } from '@/core/providers/ProviderHost';
import type {
  AcpSessionConfigOption,
  AcpSessionModelState,
  AcpSessionModeState,
} from '@/providers/acp';
import {
  extractAcpSessionModelState,
  extractAcpSessionModeState,
  extractAcpSessionThoughtLevelState,
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
  readonly configOptions?: AcpSessionConfigOption[] | null;
  readonly models?: AcpSessionModelState | null;
  readonly modes?: AcpSessionModeState | null;
  readonly selectedRawModelId?: string | null;
}

export async function projectOpencodeMetadata(
  plugin: ProviderHost,
  input: OpencodeMetadataProjectionInput,
): Promise<boolean> {
  const modelState = extractAcpSessionModelState({
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
  const modeState = extractAcpSessionModeState({
    configOptions: input.configOptions,
    modes: input.modes,
  });
  const availableModes = normalizeOpencodeAvailableModes(
    modeState.availableModes,
  );
  const thoughtState = extractAcpSessionThoughtLevelState({
    configOptions: input.configOptions,
  });
  const thinkingOptions = normalizeOpencodeModelVariants(
    thoughtState.availableLevels.map((level) => ({
      ...(level.description ? { description: level.description } : {}),
      label: level.name,
      value: level.id,
    })),
  );
  const current = getOpencodeProviderSettings(plugin.settings);
  const rawModelId = input.selectedRawModelId
    ?? modelState.currentModelId
    ?? null;
  const baseRawModelId = rawModelId
    ? resolveOpencodeBaseModelRawId(
      rawModelId,
      discoveredModels.length > 0 ? discoveredModels : current.discoveredModels,
    )
    : null;
  const nextThinking = { ...current.thinkingOptionsByModel };
  if (baseRawModelId && thinkingOptions.length > 0) {
    nextThinking[baseRawModelId] = thinkingOptions;
  }
  const hasUpdate = discoveredModels.length > 0
    || availableModes.length > 0
    || (baseRawModelId !== null && thinkingOptions.length > 0);
  if (!hasUpdate) return false;

  await plugin.mutateSettings((settings) => {
    updateOpencodeProviderSettings(settings, {
      ...(availableModes.length > 0 ? { availableModes } : {}),
      ...(discoveredModels.length > 0 ? { discoveredModels } : {}),
      ...(baseRawModelId && thinkingOptions.length > 0
        ? { thinkingOptionsByModel: nextThinking }
        : {}),
    });
  });
  plugin.notifyProviderChatOptionsChanged('opencode');
  return true;
}
