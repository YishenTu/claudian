import {
  DEFAULT_REASONING_VALUE,
  formatReasoningValueLabel,
  resolvePreferredReasoningDefault,
} from '../../../core/providers/reasoning';
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
  getGrokAvailableReasoningEfforts,
  isGrokModelSelectionId,
  resolveGrokContextWindow,
} from '../models';
import { getGrokProviderSettings, updateGrokProviderSettings } from '../settings';

const GROK_PERMISSION_MODE_TOGGLE: ProviderPermissionModeToggleConfig = {
  inactiveValue: 'normal',
  inactiveLabel: 'Safe',
  activeValue: 'yolo',
  activeLabel: 'YOLO',
};

export const grokChatUIConfig: ProviderChatUIConfig = {
  getModelOptions(settings): ProviderUIOption[] {
    const grokSettings = getGrokProviderSettings(settings);
    const catalogModels = grokSettings.currentCatalog?.models ?? [];
    const catalogById = new Map(catalogModels.map(model => [model.rawId, model] as const));
    const visibleModelIds = grokSettings.visibleModels
      ?? catalogModels.map(model => model.rawId);
    const options: ProviderUIOption[] = [];
    const seen = new Set<string>();

    for (const rawId of visibleModelIds) {
      pushModelOption(options, seen, rawId, catalogById, grokSettings.modelAliases);
    }

    return options;
  },

  getDefaultModel(settings): string | null {
    const defaultModelId = getGrokProviderSettings(settings).currentCatalog?.defaultModelId?.trim();
    const options = this.getModelOptions(settings);
    const preferred = defaultModelId ? encodeGrokModelId(defaultModelId) : null;
    return (preferred && options.some(option => option.value === preferred)
      ? preferred
      : options[0]?.value) ?? null;
  },

  ownsModel(model, settings): boolean {
    return isGrokModelSelectionId(model)
      && this.getModelOptions(settings)
        .some(option => option.value === model.trim());
  },

  isAdaptiveReasoningModel(model, settings): boolean {
    return getGrokAvailableReasoningEfforts(
      getExplicitlySelectedGrokModel(model, settings),
    ).length > 0;
  },

  getReasoningOptions(model, settings): ProviderReasoningOption[] {
    return getGrokAvailableReasoningEfforts(
      getExplicitlySelectedGrokModel(model, settings),
    ).map(option => ({
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
    const efforts = getGrokAvailableReasoningEfforts(
      getExplicitlySelectedGrokModel(model, settings),
    );
    if (efforts.length === 0) {
      return '';
    }
    const availableValues = efforts.map(effort => effort.value);
    const preferred = grokSettings.preferredReasoningByModel[rawId];
    if (preferred && availableValues.includes(preferred)) {
      return preferred;
    }
    return resolvePreferredReasoningDefault(availableValues, DEFAULT_REASONING_VALUE);
  },

  getContextWindowSize(model, customLimits = {}, settings = {}): number {
    const rawId = resolveSelectedGrokRawModelId(model, settings);
    return resolveGrokContextWindow(
      rawId ? encodeGrokModelId(rawId) : model,
      getGrokProviderSettings(settings).currentCatalog?.models ?? [],
      customLimits,
    );
  },

  isDefaultModel(): boolean {
    return false;
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
    const supportedValues = new Set(getGrokAvailableReasoningEfforts(
      getExplicitlySelectedGrokModel(model, settings),
    ).map(option => option.value));
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
  const rawId = decodeGrokModelId(normalized);
  return rawId ? encodeGrokModelId(rawId) : model;
}

function resolveSelectedGrokRawModelId(
  model: string,
  settings: Record<string, unknown>,
): string | null {
  return decodeGrokModelId(model);
}

function getExplicitlySelectedGrokModel(
  model: string,
  settings: Record<string, unknown>,
) {
  const rawId = decodeGrokModelId(model);
  if (!rawId) {
    return null;
  }
  const grokSettings = getGrokProviderSettings(settings);
  const catalogModels = grokSettings.currentCatalog?.models ?? [];
  const visibleModels = grokSettings.visibleModels
    ?? catalogModels.map(entry => entry.rawId);
  return visibleModels.includes(rawId)
    ? findGrokModel(catalogModels, rawId)
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
