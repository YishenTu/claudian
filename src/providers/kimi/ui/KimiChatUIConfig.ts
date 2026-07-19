import type {
  ProviderChatUIConfig,
  ProviderPermissionModeToggleConfig,
  ProviderReasoningOption,
  ProviderUIOption,
} from '../../../core/providers/types';
import { KIMI_PROVIDER_ICON } from '../../../shared/icons';
import {
  buildKimiBaseModels,
  decodeKimiModelId,
  encodeKimiModelId,
  isKimiModelSelectionId,
  KIMI_DEFAULT_THINKING_LEVEL,
  KIMI_SYNTHETIC_MODEL_ID,
  resolveKimiBaseModelRawId,
  resolveKimiDefaultThinkingLevel,
} from '../models';
import { getKimiProviderSettings } from '../settings';

const KIMI_MODELS: ProviderUIOption[] = [
  { value: KIMI_SYNTHETIC_MODEL_ID, label: 'Kimi Code', description: 'ACP runtime' },
];
const DEFAULT_CONTEXT_WINDOW = 262_144;
const KIMI_PERMISSION_MODE_TOGGLE: ProviderPermissionModeToggleConfig = {
  inactiveValue: 'normal',
  inactiveLabel: 'Safe',
  activeValue: 'yolo',
  activeLabel: 'YOLO',
  planValue: 'plan',
  planLabel: 'Plan',
};

export const kimiChatUIConfig: ProviderChatUIConfig = {
  getModelOptions(settings): ProviderUIOption[] {
    const kimiSettings = getKimiProviderSettings(settings);
    const applyAlias = (rawId: string, option: ProviderUIOption): ProviderUIOption => {
      const alias = kimiSettings.modelAliases[rawId];
      return alias ? { ...option, label: alias } : option;
    };
    const discoveredModels = new Map(buildKimiBaseModels(kimiSettings.discoveredModels).map((model) => [
      encodeKimiModelId(model.rawId),
      applyAlias(model.rawId, {
        description: model.description ?? 'ACP runtime',
        label: model.label,
        value: encodeKimiModelId(model.rawId),
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
    for (const rawModelId of [...kimiSettings.visibleModels].reverse()) {
      const encodedModelId = encodeKimiModelId(rawModelId);
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
      typeof savedProviderModel?.kimi === 'string'
        ? savedProviderModel.kimi
        : '',
    ];

    for (const model of selectedModelValues) {
      const rawModelId = decodeKimiModelId(model);
      if (
        !model
        || !isKimiModelSelectionId(model)
        || model === KIMI_SYNTHETIC_MODEL_ID
        || !rawModelId
      ) {
        continue;
      }

      const baseRawId = resolveKimiBaseModelRawId(rawModelId, kimiSettings.discoveredModels);
      const baseModelId = encodeKimiModelId(baseRawId);
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

    return options.length > 0 ? options : [...KIMI_MODELS];
  },

  ownsModel(model: string): boolean {
    return isKimiModelSelectionId(model);
  },

  isAdaptiveReasoningModel(model: string, settings: Record<string, unknown>): boolean {
    return getKimiThinkingOptions(model, settings).length > 0;
  },

  getReasoningOptions(model: string, settings: Record<string, unknown>): ProviderReasoningOption[] {
    return getKimiThinkingOptions(model, settings)
      .map((variant) => ({
        description: variant.description,
        label: variant.label,
        value: variant.value,
      }));
  },

  getDefaultReasoningValue(model: string, settings: Record<string, unknown>): string {
    const rawModelId = decodeKimiModelId(model);
    if (!rawModelId) {
      return KIMI_DEFAULT_THINKING_LEVEL;
    }

    const kimiSettings = getKimiProviderSettings(settings);
    const baseRawId = resolveKimiBaseModelRawId(rawModelId, kimiSettings.discoveredModels);
    return getDefaultThinkingLevelForModel(baseRawId, settings);
  },

  getContextWindowSize(model: string, customLimits?: Record<string, number>): number {
    return customLimits?.[model] ?? DEFAULT_CONTEXT_WINDOW;
  },

  isDefaultModel(model: string): boolean {
    return isKimiModelSelectionId(model);
  },

  applyModelDefaults(model: string, settings: unknown): void {
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
      return;
    }

    const settingsBag = settings as Record<string, unknown>;
    const rawModelId = decodeKimiModelId(model);
    if (!rawModelId) {
      settingsBag.effortLevel = KIMI_DEFAULT_THINKING_LEVEL;
      return;
    }

    const kimiSettings = getKimiProviderSettings(settingsBag);
    const baseRawId = resolveKimiBaseModelRawId(rawModelId, kimiSettings.discoveredModels);
    settingsBag.model = encodeKimiModelId(baseRawId);
    settingsBag.effortLevel = getDefaultThinkingLevelForModel(baseRawId, settingsBag);
  },

  normalizeModelVariant(model: string, settings: Record<string, unknown>): string {
    if (!isKimiModelSelectionId(model)) {
      return KIMI_SYNTHETIC_MODEL_ID;
    }
    const rawModelId = decodeKimiModelId(model);
    if (!rawModelId) {
      return model;
    }
    const kimiSettings = getKimiProviderSettings(settings);
    return encodeKimiModelId(resolveKimiBaseModelRawId(rawModelId, kimiSettings.discoveredModels));
  },

  getCustomModelIds(_envVars: Record<string, string>): Set<string> {
    return new Set();
  },

  getPermissionModeToggle(): ProviderPermissionModeToggleConfig {
    return KIMI_PERMISSION_MODE_TOGGLE;
  },

  getProviderIcon() {
    return KIMI_PROVIDER_ICON;
  },
};

function getKimiThinkingOptions(model: string, settings: Record<string, unknown>) {
  const rawModelId = decodeKimiModelId(model);
  if (!rawModelId) {
    return [];
  }
  const kimiSettings = getKimiProviderSettings(settings);
  const baseRawId = resolveKimiBaseModelRawId(rawModelId, kimiSettings.discoveredModels);
  return kimiSettings.thinkingOptionsByModel[baseRawId] ?? [];
}

function getDefaultThinkingLevelForModel(
  baseRawId: string,
  settings: Record<string, unknown>,
): string {
  const kimiSettings = getKimiProviderSettings(settings);
  return resolveKimiDefaultThinkingLevel(
    kimiSettings.thinkingOptionsByModel[baseRawId] ?? [],
    kimiSettings.preferredThinkingByModel[baseRawId],
  );
}

function pushOption(
  options: ProviderUIOption[],
  seenValues: Set<string>,
  value: string,
  option: ProviderUIOption,
): void {
  if (seenValues.has(value)) {
    return;
  }
  seenValues.add(value);
  options.push(option);
}
