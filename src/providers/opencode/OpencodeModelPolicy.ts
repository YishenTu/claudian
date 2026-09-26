import { formatReasoningValueLabel } from '@/core/providers/reasoning';

import type {
  ProviderModelPolicy,
  ProviderReasoningOption,
  ProviderUIOption,
} from '../../core/providers/types';
import { maybeGetOpencodeWorkspaceServices } from './app/OpencodeWorkspaceServices';
import { OpencodeMetadataService } from './metadata/OpencodeMetadataService';
import {
  buildOpencodeBaseModels,
  decodeOpencodeModelId,
  encodeOpencodeModelId,
  isOpencodeModelSelectionId,
  OPENCODE_DEFAULT_THINKING_LEVEL,
  resolveOpencodeBaseModelRawId,
  resolveOpencodeDefaultThinkingLevel,
} from './models';
import {
  resolveOpencodeModeForPermissionMode,
  resolvePermissionModeForManagedOpencodeMode,
} from './modes';
import { getOpencodeProviderSettings, updateOpencodeProviderSettings } from './settings';


export const opencodeModelPolicy: ProviderModelPolicy = {
  permissionModes: { inactiveValue: 'normal', activeValue: 'yolo' },
  getModelOptions(settings): ProviderUIOption[] {
    const opencodeSettings = getOpencodeProviderSettings(settings);
    const applyAlias = (rawId: string, option: ProviderUIOption): ProviderUIOption => {
      const alias = opencodeSettings.modelAliases[rawId];
      return alias ? { ...option, label: alias } : option;
    };
    const discoveredModels = new Map(buildOpencodeBaseModels(opencodeSettings.discoveredModels).map((model) => [
      encodeOpencodeModelId(model.rawId),
      applyAlias(model.rawId, {
        description: model.description ?? 'ACP runtime',
        label: model.label,
        value: encodeOpencodeModelId(model.rawId),
      }),
    ]));
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
    const rawModelId = current.visibleModels.find(id => buildOpencodeBaseModels(current.discoveredModels).some(model => model.rawId === id));
    return rawModelId ? encodeOpencodeModelId(rawModelId) : null;
  },

  ownsModel(model: string): boolean {
    return isOpencodeModelSelectionId(model);
  },

  isAdaptiveReasoningModel(model: string, settings: Record<string, unknown>): boolean {
    return getOpencodeThinkingOptions(model, settings).length > 0;
  },

  getReasoningOptions(model: string, settings: Record<string, unknown>): ProviderReasoningOption[] {
    const options = getOpencodeThinkingOptions(model, settings);
    if (options.every(option => option.value === OPENCODE_DEFAULT_THINKING_LEVEL)) return [];
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

    const opencodeSettings = getOpencodeProviderSettings(settings);
    const baseRawId = resolveOpencodeBaseModelRawId(rawModelId, opencodeSettings.discoveredModels);
    return getDefaultThinkingLevelForModel(baseRawId, settings);
  },

  isDefaultModel(model: string): boolean {
    return isOpencodeModelSelectionId(model);
  },

  applyModelDefaults: applyOpencodeModelDefaults,

  applyModelProjectionDefaults: applyOpencodeModelDefaults,

  async prepareModelMetadata(model: string, _settings: Record<string, unknown>, context): Promise<void> {
    const rawModelId = decodeOpencodeModelId(model);
    if (!rawModelId) {
      return;
    }

    const opencodeSettings = getOpencodeProviderSettings(context.plugin.settings);
    const baseRawId = resolveOpencodeBaseModelRawId(rawModelId, opencodeSettings.discoveredModels);
    if (baseRawId && opencodeSettings.thinkingOptionsByModel[baseRawId]) {
      return;
    }

    const workspaceService = maybeGetOpencodeWorkspaceServices()?.metadataService;
    const metadataService = workspaceService
      ?? new OpencodeMetadataService(context.plugin);
    try {
      await metadataService.warmModelMetadata(model);
    } catch {
      // Metadata warmup is opportunistic; the first real turn can still discover it.
    } finally {
      if (!workspaceService) await metadataService.dispose();
    }
  },

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
    const baseRawId = resolveOpencodeBaseModelRawId(rawModelId, opencodeSettings.discoveredModels);
    const supportedValues = new Set(
      (opencodeSettings.thinkingOptionsByModel[baseRawId] ?? []).map((variant) => variant.value),
    );
    const nextPreferredThinkingByModel = {
      ...opencodeSettings.preferredThinkingByModel,
    };

    if (!value || !supportedValues.has(value)) {
      delete nextPreferredThinkingByModel[baseRawId];
    } else {
      nextPreferredThinkingByModel[baseRawId] = value;
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

  normalizeModelVariant(model: string, settings: Record<string, unknown>): string {
    const rawModelId = decodeOpencodeModelId(model);
    if (!rawModelId) {
      return model;
    }

    const opencodeSettings = getOpencodeProviderSettings(settings);
    const baseRawId = resolveOpencodeBaseModelRawId(rawModelId, opencodeSettings.discoveredModels);
    return encodeOpencodeModelId(baseRawId);
  },

  getCustomModelIds(): Set<string> {
    return new Set<string>();
  },

  resolvePermissionMode(settings: Record<string, unknown>): string | null {
    const selectedMode = getOpencodeProviderSettings(settings).selectedMode;
    return resolvePermissionModeForManagedOpencodeMode(selectedMode);
  },

  applyPermissionMode(value: string, settings: unknown): void {
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
      return;
    }

    const settingsBag = settings as Record<string, unknown>;
    settingsBag.permissionMode = value;
    updateOpencodeProviderSettings(settingsBag, {
      selectedMode: resolveOpencodeModeForPermissionMode(
        value,
        getOpencodeProviderSettings(settingsBag).availableModes,
      ),
    });
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

  const opencodeSettings = getOpencodeProviderSettings(settingsBag);
  const baseRawId = resolveOpencodeBaseModelRawId(rawModelId, opencodeSettings.discoveredModels);
  settingsBag.model = encodeOpencodeModelId(baseRawId);
  settingsBag.effortLevel = getDefaultThinkingLevelForModel(baseRawId, settingsBag);
}

function getDefaultThinkingLevelForModel(
  baseRawId: string,
  settings: Record<string, unknown>,
): string {
  const opencodeSettings = getOpencodeProviderSettings(settings);
  return resolveOpencodeDefaultThinkingLevel(
    opencodeSettings.thinkingOptionsByModel[baseRawId] ?? [],
    opencodeSettings.preferredThinkingByModel[baseRawId],
  );
}

function getOpencodeThinkingOptions(
  model: string,
  settings: Record<string, unknown>,
): ProviderReasoningOption[] {
  const rawModelId = decodeOpencodeModelId(model);
  if (!rawModelId) {
    return [];
  }

  const opencodeSettings = getOpencodeProviderSettings(settings);
  const baseRawId = resolveOpencodeBaseModelRawId(rawModelId, opencodeSettings.discoveredModels);
  return opencodeSettings.thinkingOptionsByModel[baseRawId] ?? [];
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
