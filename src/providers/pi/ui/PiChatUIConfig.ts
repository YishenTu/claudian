import type {
  ProviderChatUIConfig,
  ProviderPermissionModeToggleConfig,
  ProviderReasoningOption,
  ProviderUIOption,
} from '../../../core/providers/types';
import { PI_PROVIDER_ICON } from '../../../shared/icons';
import {
  clampPiThinkingLevel,
  decodePiModelId,
  getPiSupportedThinkingLevels,
  isPiModelSelectionId,
  PI_DEFAULT_THINKING_LEVEL,
  PI_SYNTHETIC_MODEL_ID,
  type PiDiscoveredModel,
  type PiThinkingLevel,
} from '../models';
import {
  getPiProviderSettings,
  updatePiProviderSettings,
} from '../settings';

const PI_MODELS: ProviderUIOption[] = [
  { value: PI_SYNTHETIC_MODEL_ID, label: 'Pi', description: 'Configure models in settings' },
];
const DEFAULT_PI_REASONING_LEVELS = getPiSupportedThinkingLevels({ reasoning: true });
const DEFAULT_CONTEXT_WINDOW = 200_000;
const PI_PERMISSION_MODE_TOGGLE: ProviderPermissionModeToggleConfig = {
  inactiveValue: 'normal',
  inactiveLabel: 'Read-only',
  activeValue: 'yolo',
  activeLabel: 'All tools',
};

export const piChatUIConfig: ProviderChatUIConfig = {
  getModelOptions(settings): ProviderUIOption[] {
    const piSettings = getPiProviderSettings(settings);
    const discoveredModels = new Map(piSettings.discoveredModels.map((model) => [
      model.encodedId,
      buildModelOption(model, piSettings.modelAliases[model.encodedId]),
    ]));
    const savedProviderModel = (
      settings.savedProviderModel
      && typeof settings.savedProviderModel === 'object'
      && !Array.isArray(settings.savedProviderModel)
    )
      ? settings.savedProviderModel as Record<string, unknown>
      : null;

    const options: ProviderUIOption[] = [];
    const seen = new Set<string>();
    for (const encodedId of piSettings.visibleModels) {
      pushOption(
        options,
        seen,
        encodedId,
        discoveredModels.get(encodedId)
          ?? {
            description: 'Configured model',
            label: piSettings.modelAliases[encodedId] ?? formatFallbackLabel(encodedId),
            value: encodedId,
          },
      );
    }

    const selectedModelValues = [
      typeof settings.model === 'string' ? settings.model : '',
      typeof savedProviderModel?.pi === 'string' ? savedProviderModel.pi : '',
    ];

    for (const model of selectedModelValues) {
      if (!model || model === PI_SYNTHETIC_MODEL_ID || !decodePiModelId(model)) {
        continue;
      }

      pushOption(
        options,
        seen,
        model,
        discoveredModels.get(model)
          ?? {
            description: 'Selected in an existing session',
            label: piSettings.modelAliases[model] ?? formatFallbackLabel(model),
            value: model,
          },
      );
    }

    return options.length > 0 ? options : [...PI_MODELS];
  },

  ownsModel(model: string): boolean {
    return model === PI_SYNTHETIC_MODEL_ID || decodePiModelId(model) !== null;
  },

  isAdaptiveReasoningModel(model: string, settings: Record<string, unknown>): boolean {
    const piModel = getCachedModel(model, settings);
    if (piModel) {
      return piModel.thinkingLevels.some(level => level !== 'off');
    }

    return !!decodePiModelId(model);
  },

  getReasoningOptions(model: string, settings: Record<string, unknown>): ProviderReasoningOption[] {
    const piModel = getCachedModel(model, settings);
    const levels = piModel?.thinkingLevels
      ?? (decodePiModelId(model) ? DEFAULT_PI_REASONING_LEVELS : ['off']);
    return levels.map((level) => ({
      label: formatThinkingLevelLabel(level),
      value: level,
    }));
  },

  getDefaultReasoningValue: getPiDefaultReasoningValue,

  getContextWindowSize(
    model: string,
    customLimits?: Record<string, number>,
    settings?: Record<string, unknown>,
  ): number {
    const metadataContextWindow = settings
      ? getCachedModel(model, settings)?.contextWindow
      : undefined;
    return metadataContextWindow ?? customLimits?.[model] ?? DEFAULT_CONTEXT_WINDOW;
  },

  isDefaultModel(model: string): boolean {
    return isPiModelSelectionId(model);
  },

  applyModelDefaults(model: string, settings: unknown): void {
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
      return;
    }

    const settingsBag = settings as Record<string, unknown>;
    if (!decodePiModelId(model)) {
      settingsBag.effortLevel = 'off';
      return;
    }

    settingsBag.model = model;
    settingsBag.effortLevel = getPiDefaultReasoningValue(model, settingsBag);
  },

  applyReasoningSelection(model: string, value: string, settings: unknown): void {
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
      return;
    }

    const settingsBag = settings as Record<string, unknown>;
    const piModel = getCachedModel(model, settingsBag);
    const encodedId = piModel?.encodedId ?? (decodePiModelId(model) ? model : '');
    if (!encodedId) {
      return;
    }
    const supportedLevels = piModel?.thinkingLevels ?? DEFAULT_PI_REASONING_LEVELS;

    const nextPreferredThinkingByModel = {
      ...getPiProviderSettings(settingsBag).preferredThinkingByModel,
    };
    const normalizedValue = value as PiThinkingLevel;
    if (!supportedLevels.includes(normalizedValue)) {
      delete nextPreferredThinkingByModel[encodedId];
    } else {
      nextPreferredThinkingByModel[encodedId] = normalizedValue;
    }

    updatePiProviderSettings(settingsBag, {
      preferredThinkingByModel: nextPreferredThinkingByModel,
    });
  },

  normalizeModelVariant(model: string): string {
    return decodePiModelId(model) ? model : model;
  },

  getCustomModelIds(): Set<string> {
    return new Set<string>();
  },

  getModeSelector(): null {
    return null;
  },

  getPermissionModeToggle(): ProviderPermissionModeToggleConfig {
    return PI_PERMISSION_MODE_TOGGLE;
  },

  resolvePermissionMode(settings: Record<string, unknown>): string | null {
    return getPiProviderSettings(settings).toolMode === 'readonly' ? 'normal' : 'yolo';
  },

  applyPermissionMode(value: string, settings: unknown): void {
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
      return;
    }

    const settingsBag = settings as Record<string, unknown>;
    settingsBag.permissionMode = value;
    updatePiProviderSettings(settingsBag, {
      toolMode: value === 'normal' ? 'readonly' : 'all',
    });
  },

  getProviderIcon() {
    return PI_PROVIDER_ICON;
  },
};

function getCachedModel(model: string, settings: Record<string, unknown>): PiDiscoveredModel | null {
  if (!decodePiModelId(model)) {
    return null;
  }

  return getPiProviderSettings(settings).discoveredModels.find(entry => entry.encodedId === model) ?? null;
}

function getPiDefaultReasoningValue(model: string, settings: Record<string, unknown>): string {
  const piModel = getCachedModel(model, settings);
  if (!piModel) {
    return decodePiModelId(model) ? PI_DEFAULT_THINKING_LEVEL : 'off';
  }

  const piSettings = getPiProviderSettings(settings);
  return clampPiThinkingLevel(
    piSettings.preferredThinkingByModel[piModel.encodedId],
    piModel.thinkingLevels,
  );
}

function buildModelOption(model: PiDiscoveredModel, alias: string | undefined): ProviderUIOption {
  return {
    description: `${model.provider} runtime`,
    group: model.provider,
    label: alias ?? model.label,
    value: model.encodedId,
  };
}

function formatFallbackLabel(encodedId: string): string {
  const decoded = decodePiModelId(encodedId);
  return decoded ? `${decoded.provider}/${decoded.modelId}` : 'Pi';
}

function formatThinkingLevelLabel(value: PiThinkingLevel): string {
  return value === 'xhigh'
    ? 'XHigh'
    : value.charAt(0).toUpperCase() + value.slice(1);
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
