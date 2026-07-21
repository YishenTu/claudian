import { formatReasoningValueLabel } from '../../../core/providers/reasoning';
import type {
  ProviderChatUIConfig,
  ProviderPermissionModeToggleConfig,
  ProviderReasoningOption,
  ProviderUIOption,
} from '../../../core/providers/types';
import { GROK_PROVIDER_ICON } from '../../../shared/icons';
import {
  decodeGrokModelId,
  encodeGrokModelId,
  findGrokModel,
  GROK_SYNTHETIC_MODEL_ID,
  isGrokModelSelectionId,
  resolveGrokContextWindow,
  resolveGrokDefaultReasoningEffort,
  resolveGrokRawModelId,
} from '../models';
import { getGrokProviderSettings, updateGrokProviderSettings } from '../settings';

const GROK_PERMISSION_MODE_TOGGLE: ProviderPermissionModeToggleConfig = {
  inactiveValue: 'normal',
  inactiveLabel: 'Safe',
  activeValue: 'yolo',
  activeLabel: 'YOLO',
};

const GROK_NATIVE_DEFAULT_OPTION: ProviderUIOption = {
  value: GROK_SYNTHETIC_MODEL_ID,
  label: 'Grok (native default)',
  description: 'Use the model selected by Grok',
};

export const grokChatUIConfig: ProviderChatUIConfig = {
  getModelOptions(settings): ProviderUIOption[] {
    const grokSettings = getGrokProviderSettings(settings);
    const catalogModels = grokSettings.currentCatalog?.models ?? [];
    const catalogById = new Map(catalogModels.map(model => [model.rawId, model] as const));
    const visibleModelIds = grokSettings.visibleModels
      ?? catalogModels.map(model => model.rawId);
    const options = [GROK_NATIVE_DEFAULT_OPTION];
    const seen = new Set([GROK_SYNTHETIC_MODEL_ID]);

    for (const rawId of visibleModelIds) {
      pushModelOption(options, seen, rawId, catalogById, grokSettings.modelAliases);
    }

    const savedProviderModel = isRecord(settings.savedProviderModel)
      ? settings.savedProviderModel.grok
      : null;
    for (const selected of [
      settings.model,
      savedProviderModel,
      settings.titleGenerationModel,
    ]) {
      if (typeof selected !== 'string' || selected === GROK_SYNTHETIC_MODEL_ID) {
        continue;
      }
      const rawId = decodeGrokModelId(selected);
      if (rawId) {
        pushModelOption(options, seen, rawId, catalogById, grokSettings.modelAliases);
      }
    }

    return options;
  },

  getDefaultModel(): string {
    return GROK_SYNTHETIC_MODEL_ID;
  },

  ownsModel(model): boolean {
    return isGrokModelSelectionId(model);
  },

  isAdaptiveReasoningModel(model, settings): boolean {
    return Boolean(getExplicitlySelectedGrokModel(model, settings)?.supportsReasoning);
  },

  getReasoningOptions(model, settings): ProviderReasoningOption[] {
    return (getExplicitlySelectedGrokModel(model, settings)?.reasoningEfforts ?? [])
      .map(option => ({
        ...(option.description ? { description: option.description } : {}),
        label: formatReasoningValueLabel(option.value),
        value: option.value,
      }));
  },

  getDefaultReasoningValue(model, settings): string {
    const grokSettings = getGrokProviderSettings(settings);
    const rawId = decodeGrokModelId(model);
    if (!rawId) {
      return '';
    }
    const discoveredModel = findGrokModel(
      grokSettings.currentCatalog?.models ?? [],
      rawId,
    );
    return resolveGrokDefaultReasoningEffort(
      discoveredModel,
      rawId ? grokSettings.preferredReasoningByModel[rawId] : undefined,
    );
  },

  getContextWindowSize(model, customLimits = {}, settings = {}): number {
    const rawId = resolveSelectedGrokRawModelId(model, settings);
    return resolveGrokContextWindow(
      rawId ? encodeGrokModelId(rawId) : model,
      getGrokProviderSettings(settings).currentCatalog?.models ?? [],
      customLimits,
    );
  },

  isDefaultModel(model): boolean {
    return model.trim() === GROK_SYNTHETIC_MODEL_ID;
  },

  applyModelDefaults(model, settings): void {
    if (!isRecord(settings)) {
      return;
    }
    const normalizedModel = normalizeSelection(model);
    if (!isGrokModelSelectionId(normalizedModel)) {
      return;
    }
    clearSavedGrokEffortProjection(settings);
    settings.model = normalizedModel;
    if (normalizedModel === GROK_SYNTHETIC_MODEL_ID) {
      delete settings.effortLevel;
      return;
    }
    settings.effortLevel = this.getDefaultReasoningValue(normalizedModel, settings);
  },

  applyModelProjectionDefaults(model, settings): void {
    if (!isRecord(settings)) {
      return;
    }
    clearSavedGrokEffortProjection(settings);
    const rawId = decodeGrokModelId(model);
    if (!rawId) {
      delete settings.effortLevel;
      return;
    }
    settings.effortLevel = this.getDefaultReasoningValue(model, settings);
  },

  applyReasoningSelection(model, value, settings): void {
    if (!isRecord(settings)) {
      return;
    }
    const rawId = decodeGrokModelId(model);
    if (!rawId) {
      clearSavedGrokEffortProjection(settings);
      delete settings.effortLevel;
      return;
    }
    const grokSettings = getGrokProviderSettings(settings);
    const discoveredModel = findGrokModel(grokSettings.currentCatalog?.models ?? [], rawId);
    const supportedValues = new Set(discoveredModel?.reasoningEfforts.map(option => option.value) ?? []);
    const preferredReasoningByModel = { ...grokSettings.preferredReasoningByModel };
    if (supportedValues.has(value)) {
      preferredReasoningByModel[rawId] = value;
    } else {
      delete preferredReasoningByModel[rawId];
    }
    updateGrokProviderSettings(settings, { preferredReasoningByModel });
  },

  normalizeModelVariant(model): string {
    return normalizeSelection(model);
  },

  getCustomModelIds(): Set<string> {
    return new Set();
  },

  getPermissionModeToggle(): ProviderPermissionModeToggleConfig {
    return GROK_PERMISSION_MODE_TOGGLE;
  },

  resolvePermissionMode(settings): string {
    return settings.permissionMode === 'yolo' ? 'yolo' : 'normal';
  },

  applyPermissionMode(value, settings): void {
    if (isRecord(settings)) {
      settings.permissionMode = value === 'yolo' ? 'yolo' : 'normal';
    }
  },

  getModeSelector(): null {
    return null;
  },

  getProviderIcon() {
    return GROK_PROVIDER_ICON;
  },
};

function pushModelOption(
  options: ProviderUIOption[],
  seen: Set<string>,
  rawId: string,
  catalogById: ReadonlyMap<string, { description?: string; displayName: string }>,
  aliases: Record<string, string>,
): void {
  const value = encodeGrokModelId(rawId);
  if (seen.has(value)) {
    return;
  }
  seen.add(value);
  const model = catalogById.get(rawId);
  options.push({
    value,
    label: aliases[rawId] ?? model?.displayName ?? rawId,
    description: model?.description ?? 'Selected in an existing session',
  });
}

function normalizeSelection(model: string): string {
  const normalized = model.trim();
  if (normalized === GROK_SYNTHETIC_MODEL_ID) {
    return GROK_SYNTHETIC_MODEL_ID;
  }
  const rawId = decodeGrokModelId(normalized);
  return rawId ? encodeGrokModelId(rawId) : model;
}

function resolveSelectedGrokRawModelId(
  model: string,
  settings: Record<string, unknown>,
): string | null {
  return resolveGrokRawModelId(
    model,
    getGrokProviderSettings(settings).currentCatalog?.defaultModelId,
  );
}

function getExplicitlySelectedGrokModel(
  model: string,
  settings: Record<string, unknown>,
) {
  const rawId = decodeGrokModelId(model);
  return rawId
    ? findGrokModel(
      getGrokProviderSettings(settings).currentCatalog?.models ?? [],
      rawId,
    )
    : null;
}

function clearSavedGrokEffortProjection(settings: Record<string, unknown>): void {
  if (isRecord(settings.savedProviderEffort)) {
    delete settings.savedProviderEffort.grok;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
