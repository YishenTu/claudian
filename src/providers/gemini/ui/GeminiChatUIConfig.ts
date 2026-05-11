import type {
  ProviderChatUIConfig,
  ProviderPermissionModeToggleConfig,
  ProviderReasoningOption,
  ProviderUIOption,
} from '../../../core/providers/types';
import { GEMINI_PROVIDER_ICON } from '../../../shared/icons';
import {
  buildGeminiBaseModels,
  decodeGeminiModelId,
  encodeGeminiModelId,
  GEMINI_DEFAULT_THINKING_LEVEL,
  GEMINI_SYNTHETIC_MODEL_ID,
  getGeminiModelVariants,
  isGeminiModelSelectionId,
  resolveGeminiBaseModelRawId,
} from '../models';
import {
  resolveGeminiModeForPermissionMode,
  resolvePermissionModeForManagedGeminiMode,
} from '../modes';
import { getGeminiProviderSettings, updateGeminiProviderSettings } from '../settings';

const GEMINI_MODELS: ProviderUIOption[] = [
  { value: GEMINI_SYNTHETIC_MODEL_ID, label: 'Gemini', description: 'ACP runtime' },
];
const DEFAULT_CONTEXT_WINDOW = 200_000;
const GEMINI_PERMISSION_MODE_TOGGLE: ProviderPermissionModeToggleConfig = {
  inactiveValue: 'normal',
  inactiveLabel: 'Safe',
  activeValue: 'yolo',
  activeLabel: 'YOLO',
  planValue: 'plan',
  planLabel: 'Plan',
};

export const geminiChatUIConfig: ProviderChatUIConfig = {
  getModelOptions(settings): ProviderUIOption[] {
    const geminiSettings = getGeminiProviderSettings(settings);
    const applyAlias = (rawId: string, option: ProviderUIOption): ProviderUIOption => {
      const alias = geminiSettings.modelAliases[rawId];
      return alias ? { ...option, label: alias } : option;
    };
    const discoveredModels = new Map(buildGeminiBaseModels(geminiSettings.discoveredModels).map((model) => [
      encodeGeminiModelId(model.rawId),
      applyAlias(model.rawId, {
        description: model.description ?? 'ACP runtime',
        label: model.label,
        value: encodeGeminiModelId(model.rawId),
      }),
    ]));
    const savedProviderModel = (
      settings.savedProviderModel
      && typeof settings.savedProviderModel === 'object'
      && !Array.isArray(settings.savedProviderModel)
    )
      ? settings.savedProviderModel as Record<string, unknown>
      : null;

    const seenValues = new Set<string>();
    const options: ProviderUIOption[] = [];
    for (const rawModelId of geminiSettings.visibleModels) {
      const encodedModelId = encodeGeminiModelId(rawModelId);
      pushOption(
        options,
        seenValues,
        encodedModelId,
        discoveredModels.get(encodedModelId)
          ?? applyAlias(rawModelId, {
            description: 'Configured model',
            label: rawModelId,
            value: encodedModelId,
          }),
      );
    }

    const selectedModelValues = [
      typeof settings.model === 'string' ? settings.model : '',
      typeof savedProviderModel?.gemini === 'string'
        ? savedProviderModel.gemini
        : '',
    ];

    for (const model of selectedModelValues) {
      const rawModelId = decodeGeminiModelId(model);
      if (
        !model
        || !isGeminiModelSelectionId(model)
        || model === GEMINI_SYNTHETIC_MODEL_ID
        || !rawModelId
      ) {
        continue;
      }

      const baseRawId = resolveGeminiBaseModelRawId(rawModelId, geminiSettings.discoveredModels);
      const baseModelId = encodeGeminiModelId(baseRawId);
      pushOption(
        options,
        seenValues,
        baseModelId,
        discoveredModels.get(baseModelId)
          ?? applyAlias(baseRawId, {
            description: 'Selected in an existing session',
            label: baseRawId,
            value: baseModelId,
          }),
      );
    }

    return options.length > 0 ? options : [...GEMINI_MODELS];
  },

  ownsModel(model: string): boolean {
    return isGeminiModelSelectionId(model);
  },

  isAdaptiveReasoningModel(_model: string, _settings: Record<string, unknown>): boolean {
    return true;
  },

  getReasoningOptions(model: string, settings: Record<string, unknown>): ProviderReasoningOption[] {
    const rawModelId = decodeGeminiModelId(model);
    if (!rawModelId) {
      return [];
    }

    const geminiSettings = getGeminiProviderSettings(settings);
    const baseRawId = resolveGeminiBaseModelRawId(rawModelId, geminiSettings.discoveredModels);
    const variants = getGeminiModelVariants(baseRawId, geminiSettings.discoveredModels);
    if (variants.length === 0) {
      return [];
    }

    return [
      { value: GEMINI_DEFAULT_THINKING_LEVEL, label: 'Default' },
      ...variants.map((variant) => ({
        description: variant.description,
        label: variant.label,
        value: variant.value,
      })),
    ];
  },

  getDefaultReasoningValue(model: string, settings: Record<string, unknown>): string {
    const rawModelId = decodeGeminiModelId(model);
    if (!rawModelId) {
      return GEMINI_DEFAULT_THINKING_LEVEL;
    }

    const geminiSettings = getGeminiProviderSettings(settings);
    const baseRawId = resolveGeminiBaseModelRawId(rawModelId, geminiSettings.discoveredModels);
    return getDefaultThinkingLevelForModel(baseRawId, settings);
  },

  getContextWindowSize(model: string, customLimits?: Record<string, number>): number {
    return customLimits?.[model] ?? DEFAULT_CONTEXT_WINDOW;
  },

  isDefaultModel(model: string): boolean {
    return isGeminiModelSelectionId(model);
  },

  applyModelDefaults(model: string, settings: unknown): void {
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
      return;
    }

    const settingsBag = settings as Record<string, unknown>;
    const rawModelId = decodeGeminiModelId(model);
    if (!rawModelId) {
      settingsBag.effortLevel = GEMINI_DEFAULT_THINKING_LEVEL;
      return;
    }

    const geminiSettings = getGeminiProviderSettings(settingsBag);
    const baseRawId = resolveGeminiBaseModelRawId(rawModelId, geminiSettings.discoveredModels);
    settingsBag.model = encodeGeminiModelId(baseRawId);
    settingsBag.effortLevel = getDefaultThinkingLevelForModel(baseRawId, settingsBag);
  },

  applyReasoningSelection(model: string, value: string, settings: unknown): void {
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
      return;
    }

    const settingsBag = settings as Record<string, unknown>;
    const rawModelId = decodeGeminiModelId(model);
    if (!rawModelId) {
      return;
    }

    const geminiSettings = getGeminiProviderSettings(settingsBag);
    const baseRawId = resolveGeminiBaseModelRawId(rawModelId, geminiSettings.discoveredModels);
    const supportedValues = new Set(
      getGeminiModelVariants(baseRawId, geminiSettings.discoveredModels).map((variant) => variant.value),
    );
    const nextPreferredThinkingByModel = {
      ...geminiSettings.preferredThinkingByModel,
    };

    if (!value || value === GEMINI_DEFAULT_THINKING_LEVEL || !supportedValues.has(value)) {
      delete nextPreferredThinkingByModel[baseRawId];
    } else {
      nextPreferredThinkingByModel[baseRawId] = value;
    }

    updateGeminiProviderSettings(settingsBag, {
      preferredThinkingByModel: nextPreferredThinkingByModel,
    });
  },

  normalizeModelVariant(model: string, settings: Record<string, unknown>): string {
    const rawModelId = decodeGeminiModelId(model);
    if (!rawModelId) {
      return model;
    }

    const geminiSettings = getGeminiProviderSettings(settings);
    const baseRawId = resolveGeminiBaseModelRawId(rawModelId, geminiSettings.discoveredModels);
    return encodeGeminiModelId(baseRawId);
  },

  getCustomModelIds(): Set<string> {
    return new Set<string>();
  },

  getModeSelector(): null {
    return null;
  },

  getPermissionModeToggle(): ProviderPermissionModeToggleConfig {
    return GEMINI_PERMISSION_MODE_TOGGLE;
  },

  resolvePermissionMode(settings: Record<string, unknown>): string | null {
    const selectedMode = getGeminiProviderSettings(settings).selectedMode;
    return resolvePermissionModeForManagedGeminiMode(selectedMode);
  },

  applyPermissionMode(value: string, settings: unknown): void {
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
      return;
    }

    const settingsBag = settings as Record<string, unknown>;
    settingsBag.permissionMode = value;
    updateGeminiProviderSettings(settingsBag, {
      selectedMode: resolveGeminiModeForPermissionMode(
        value,
        getGeminiProviderSettings(settingsBag).availableModes,
      ),
    });
  },

  getProviderIcon() {
    return GEMINI_PROVIDER_ICON;
  },
};

function getDefaultThinkingLevelForModel(
  baseRawId: string,
  settings: Record<string, unknown>,
): string {
  const geminiSettings = getGeminiProviderSettings(settings);
  const preferred = geminiSettings.preferredThinkingByModel[baseRawId];
  const supportedValues = new Set(
    getGeminiModelVariants(baseRawId, geminiSettings.discoveredModels).map((variant) => variant.value),
  );
  if (preferred && supportedValues.has(preferred)) {
    return preferred;
  }

  return GEMINI_DEFAULT_THINKING_LEVEL;
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
