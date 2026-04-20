import type {
  ProviderChatUIConfig,
  ProviderModeSelectorConfig,
  ProviderReasoningOption,
  ProviderUIOption,
} from '../../../core/providers/types';
import { OPENCODE_PROVIDER_ICON } from '../../../shared/icons';
import {
  buildOpencodeBaseModels,
  decodeOpencodeModelId,
  encodeOpencodeModelId,
  getOpencodeModelVariants,
  isOpencodeModelSelectionId,
  OPENCODE_DEFAULT_THINKING_LEVEL,
  OPENCODE_SYNTHETIC_MODEL_ID,
  resolveOpencodeBaseModelRawId,
} from '../models';
import { getOpencodeToolbarModes, OPENCODE_FALLBACK_MODES, type OpencodeMode } from '../modes';
import { getOpencodeProviderSettings, updateOpencodeProviderSettings } from '../settings';

const OPENCODE_MODELS: ProviderUIOption[] = [
  { value: OPENCODE_SYNTHETIC_MODEL_ID, label: 'OpenCode', description: 'ACP runtime' },
];
const DEFAULT_CONTEXT_WINDOW = 200_000;

export const opencodeChatUIConfig: ProviderChatUIConfig = {
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
    const savedProviderModel = (
      settings.savedProviderModel
      && typeof settings.savedProviderModel === 'object'
      && !Array.isArray(settings.savedProviderModel)
    )
      ? settings.savedProviderModel as Record<string, unknown>
      : null;

    const seenValues = new Set<string>();
    const options: ProviderUIOption[] = [];
    for (const rawModelId of opencodeSettings.visibleModels) {
      const encodedModelId = encodeOpencodeModelId(rawModelId);
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
      typeof savedProviderModel?.opencode === 'string'
        ? savedProviderModel.opencode
        : '',
    ];

    for (const model of selectedModelValues) {
      const rawModelId = decodeOpencodeModelId(model);
      if (
        !model
        || !isOpencodeModelSelectionId(model)
        || model === OPENCODE_SYNTHETIC_MODEL_ID
        || !rawModelId
      ) {
        continue;
      }

      const baseRawId = resolveOpencodeBaseModelRawId(rawModelId, opencodeSettings.discoveredModels);
      const baseModelId = encodeOpencodeModelId(baseRawId);
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

    return options.length > 0 ? options : [...OPENCODE_MODELS];
  },

  ownsModel(model: string): boolean {
    return isOpencodeModelSelectionId(model);
  },

  isAdaptiveReasoningModel(_model: string, _settings: Record<string, unknown>): boolean {
    return true;
  },

  getReasoningOptions(model: string, settings: Record<string, unknown>): ProviderReasoningOption[] {
    const rawModelId = decodeOpencodeModelId(model);
    if (!rawModelId) {
      return [];
    }

    const opencodeSettings = getOpencodeProviderSettings(settings);
    const baseRawId = resolveOpencodeBaseModelRawId(rawModelId, opencodeSettings.discoveredModels);
    const variants = getOpencodeModelVariants(baseRawId, opencodeSettings.discoveredModels);
    if (variants.length === 0) {
      return [];
    }

    return [
      { value: OPENCODE_DEFAULT_THINKING_LEVEL, label: 'Default' },
      ...variants.map((variant) => ({
        description: variant.description,
        label: variant.label,
        value: variant.value,
      })),
    ];
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

  getContextWindowSize(model: string, customLimits?: Record<string, number>): number {
    return customLimits?.[model] ?? DEFAULT_CONTEXT_WINDOW;
  },

  isDefaultModel(model: string): boolean {
    return isOpencodeModelSelectionId(model);
  },

  applyModelDefaults(model: string, settings: unknown): void {
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
      getOpencodeModelVariants(baseRawId, opencodeSettings.discoveredModels).map((variant) => variant.value),
    );
    const nextPreferredThinkingByModel = {
      ...opencodeSettings.preferredThinkingByModel,
    };

    if (!value || value === OPENCODE_DEFAULT_THINKING_LEVEL || !supportedValues.has(value)) {
      delete nextPreferredThinkingByModel[baseRawId];
    } else {
      nextPreferredThinkingByModel[baseRawId] = value;
    }

    updateOpencodeProviderSettings(settingsBag, {
      preferredThinkingByModel: nextPreferredThinkingByModel,
    });
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

  getModeSelector(settings: Record<string, unknown>): ProviderModeSelectorConfig | null {
    const opencodeSettings = getOpencodeProviderSettings(settings);
    if (
      opencodeSettings.availableModes.length === 0
      && opencodeSettings.selectedMode
      && !OPENCODE_FALLBACK_MODES.some((mode) => mode.id === opencodeSettings.selectedMode)
    ) {
      return null;
    }

    const availableModes = getOpencodeToolbarModes(opencodeSettings.availableModes);
    if (availableModes.length <= 1) {
      return null;
    }

    const selectedMode = availableModes.some((mode: OpencodeMode) => mode.id === opencodeSettings.selectedMode)
      ? opencodeSettings.selectedMode
      : availableModes[0]?.id || '';

    return {
      activeValue: 'build',
      label: 'Mode',
      options: availableModes.map((mode: OpencodeMode) => ({
        ...(mode.description ? { description: mode.description } : {}),
        label: formatOpencodeModeLabel(mode.name),
        value: mode.id,
      })),
      value: selectedMode,
    };
  },

  applyModeSelection(value: string, settings: unknown): void {
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
      return;
    }

    updateOpencodeProviderSettings(settings as Record<string, unknown>, {
      selectedMode: value,
    });
  },

  getProviderIcon() {
    return OPENCODE_PROVIDER_ICON;
  },
};

function getDefaultThinkingLevelForModel(
  baseRawId: string,
  settings: Record<string, unknown>,
): string {
  const opencodeSettings = getOpencodeProviderSettings(settings);
  const preferred = opencodeSettings.preferredThinkingByModel[baseRawId];
  const supportedValues = new Set(
    getOpencodeModelVariants(baseRawId, opencodeSettings.discoveredModels).map((variant) => variant.value),
  );
  if (preferred && supportedValues.has(preferred)) {
    return preferred;
  }

  return OPENCODE_DEFAULT_THINKING_LEVEL;
}

function formatOpencodeModeLabel(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return '';
  }

  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
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
