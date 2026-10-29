import { formatReasoningValueLabel } from '@/core/providers/reasoning';

import type {
  ProviderModelPolicy,
  ProviderUIOption,
} from '../../core/providers/types';
import { OpencodeMetadataService } from './metadata/OpencodeMetadataService';
import {
  decodeOpencodeModelId,
  encodeOpencodeModelId,
  isOpencodeModelSelectionId,
  OPENCODE_DEFAULT_THINKING_LEVEL,
  resolveOpencodeDefaultThinkingLevel,
  splitOpencodeModelLabel,
} from './models';
import { OPENCODE_PERMISSION_MODE_POLICY } from './permissionModes';
import { getOpencodeProviderSettings, updateOpencodeProviderSettings } from './settings';


export const opencodeModelPolicy: ProviderModelPolicy = {
  permissionModes: OPENCODE_PERMISSION_MODE_POLICY,
  getModelOptions(settings): ProviderUIOption[] {
    const opencodeSettings = getOpencodeProviderSettings(settings);
    // Native labels read "Upstream/Model": the upstream provider becomes the group, the rest the name.
    const discoveredModels = new Map(opencodeSettings.discoveredModels.map((model) => {
      const { modelLabel, providerLabel } = splitOpencodeModelLabel(model.label);
      const hasUpstream = model.label.includes('/');
      const option: ProviderUIOption = {
        ...(model.description ? { description: model.description } : {}),
        ...(hasUpstream ? { group: providerLabel } : {}),
        label: Object.hasOwn(opencodeSettings.modelAliases, model.rawId) ? opencodeSettings.modelAliases[model.rawId] : modelLabel,
        value: encodeOpencodeModelId(model.rawId),
      };
      return [option.value, option];
    }));
    const seenValues = new Set<string>();
    const options: ProviderUIOption[] = [];
    for (const rawModelId of [...opencodeSettings.visibleModels]) {
      const encodedModelId = encodeOpencodeModelId(rawModelId);
      const option = discoveredModels.get(encodedModelId);
      if (option) pushOption(options, seenValues, encodedModelId, option);
    }

    return options;
  },

  getDefaultModel(settings: Record<string, unknown>): string | null {
    const current = getOpencodeProviderSettings(settings);
    const rawModelId = current.visibleModels.find(id => current.discoveredModels.some(model => model.rawId === id));
    return rawModelId ? encodeOpencodeModelId(rawModelId) : null;
  },

  ownsModel(model: string): boolean {
    return isOpencodeModelSelectionId(model);
  },

  supportsReasoningEffort(model: string, settings: Record<string, unknown>): boolean {
    return getOpencodeThinkingOptions(model, settings).length > 0;
  },

  getReasoningOptions(model: string, settings: Record<string, unknown>): ProviderUIOption[] {
    const options = getOpencodeThinkingOptions(model, settings)
      .filter(option => option.value !== OPENCODE_DEFAULT_THINKING_LEVEL);
    return options.map((variant) => ({
        description: variant.description,
        label: formatReasoningValueLabel(variant.label),
        value: variant.value,
      }));
  },

  getDefaultReasoningValue(model: string, settings: Record<string, unknown>): string {
    const rawModelId = decodeOpencodeModelId(model);
    if (!rawModelId) {
      return OPENCODE_DEFAULT_THINKING_LEVEL;
    }

    return getDefaultThinkingLevelForModel(rawModelId, settings);
  },

  isDefaultModel(model: string): boolean {
    return isOpencodeModelSelectionId(model);
  },

  applyModelDefaults: applyOpencodeModelDefaults,

  applyModelProjectionDefaults: applyOpencodeModelDefaults,

  applyReasoningSelection(model: string, value: string, settings: unknown): void {
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
      return;
    }

    const settingsBag = settings as Record<string, unknown>;
    const rawModelId = decodeOpencodeModelId(model);
    if (!rawModelId) {
      return;
    }

    const opencodeSettings = getOpencodeProviderSettings(settingsBag);
    const supportedValues = new Set(
      (Object.hasOwn(opencodeSettings.thinkingOptionsByModel, rawModelId) ? opencodeSettings.thinkingOptionsByModel[rawModelId] : []).map((variant) => variant.value),
    );
    const nextPreferredThinkingByModel = {
      ...opencodeSettings.preferredThinkingByModel,
    };

    if (!value || !supportedValues.has(value)) {
      delete nextPreferredThinkingByModel[rawModelId];
    } else {
      Object.defineProperty(nextPreferredThinkingByModel, rawModelId, { value, enumerable: true, writable: true, configurable: true });
    }

    updateOpencodeProviderSettings(settingsBag, {
      preferredThinkingByModel: nextPreferredThinkingByModel,
    });
  },

  normalizeAvailableModelSelection(model: string): string {
    return isOpencodeModelSelectionId(model)
      ? model
      : encodeOpencodeModelId(model);
  },

  normalizeModelVariant: model => model,

  getCustomModelIds(): Set<string> {
    return new Set<string>();
  }
};

function applyOpencodeModelDefaults(model: string, settings: unknown): void {
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
    return;
  }

  const settingsBag = settings as Record<string, unknown>;
  const rawModelId = decodeOpencodeModelId(model);
  if (!rawModelId) {
    settingsBag.effortLevel = OPENCODE_DEFAULT_THINKING_LEVEL;
    return;
  }

  settingsBag.model = encodeOpencodeModelId(rawModelId);
  settingsBag.effortLevel = getDefaultThinkingLevelForModel(rawModelId, settingsBag);
}

function getDefaultThinkingLevelForModel(
  rawModelId: string,
  settings: Record<string, unknown>,
): string {
  const opencodeSettings = getOpencodeProviderSettings(settings);
  return resolveOpencodeDefaultThinkingLevel(
    Object.hasOwn(opencodeSettings.thinkingOptionsByModel, rawModelId) ? opencodeSettings.thinkingOptionsByModel[rawModelId] : [],
    Object.hasOwn(opencodeSettings.preferredThinkingByModel, rawModelId) ? opencodeSettings.preferredThinkingByModel[rawModelId] : undefined,
  );
}

function getOpencodeThinkingOptions(
  model: string,
  settings: Record<string, unknown>,
): ProviderUIOption[] {
  const rawModelId = decodeOpencodeModelId(model);
  if (!rawModelId) {
    return [];
  }

  const opencodeSettings = getOpencodeProviderSettings(settings);
  return Object.hasOwn(opencodeSettings.thinkingOptionsByModel, rawModelId) ? opencodeSettings.thinkingOptionsByModel[rawModelId] : [];
}

function pushOption(
  target: ProviderUIOption[],
  seenValues: Set<string>,
  value: string,
  option: ProviderUIOption,
): void {
  if (seenValues.has(value)) {
    return;
  }

  seenValues.add(value);
  target.push(option);
}

/**
 * Warms model-scoped metadata after selection. Reuses the shared workspace metadata
 * service when initialized; otherwise owns and disposes a temporary one.
 */
export function createOpencodeModelMetadataPreparer(
  getSharedMetadataService: () => OpencodeMetadataService | null | undefined,
): NonNullable<ProviderModelPolicy['prepareModelMetadata']> {
  return async (model, _settings, context) => {
    const rawModelId = decodeOpencodeModelId(model);
    if (!rawModelId) {
      return;
    }

    const opencodeSettings = getOpencodeProviderSettings(context.plugin.settings);
    if (Object.hasOwn(opencodeSettings.thinkingOptionsByModel, rawModelId)) {
      return;
    }

    const workspaceService = getSharedMetadataService();
    const metadataService = workspaceService
      ?? new OpencodeMetadataService(context.plugin.getRuntimeHost('opencode'), context.plugin.executionLifecycleRegistry);
    try {
      await metadataService.warmModelMetadata(model);
    } catch {
      // Metadata warmup is opportunistic; the first real turn can still discover it.
    } finally {
      if (!workspaceService) await metadataService.dispose();
    }
  };
}
