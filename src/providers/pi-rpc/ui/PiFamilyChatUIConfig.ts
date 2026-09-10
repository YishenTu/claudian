import { formatReasoningValueLabel } from '../../../core/providers/reasoning';
import type {
  ProviderChatUIConfig,
  ProviderPermissionModeToggleConfig,
  ProviderReasoningOption,
  ProviderUIOption,
} from '../../../core/providers/types';
import type { ProviderIconSvg } from '../../../core/providers/types';
import type { PiDiscoveredModel, PiThinkingLevel } from '../models';
import type { PiFamilyProfile } from '../PiFamilyProfile';

const DEFAULT_CONTEXT_WINDOW = 200_000;

const PI_FAMILY_PERMISSION_MODE_TOGGLE: ProviderPermissionModeToggleConfig = {
  inactiveValue: 'normal',
  inactiveLabel: 'Read-only',
  activeValue: 'yolo',
  activeLabel: 'All tools',
};

export interface PiFamilyChatUIConfigOptions {
  readonly icon: ProviderIconSvg;
}

export function definePiFamilyChatUIConfig(
  profile: PiFamilyProfile,
  options: PiFamilyChatUIConfigOptions,
): ProviderChatUIConfig {
  const defaultReasoningLevels = profile.models.getSupportedThinkingLevels({ reasoning: true });

  const getCachedModel = (
    model: string,
    settings: Record<string, unknown>,
  ): PiDiscoveredModel | null => {
    if (!profile.models.decodeModelId(model)) {
      return null;
    }

    return profile.settings.get(settings).discoveredModels.find(entry => entry.encodedId === model) ?? null;
  };

  const getDefaultReasoningValue = (
    model: string,
    settings: Record<string, unknown>,
  ): string => {
    const familyModel = getCachedModel(model, settings);
    if (!familyModel) {
      return profile.models.decodeModelId(model) ? profile.models.defaultThinkingLevel : 'off';
    }

    return profile.models.clampThinkingLevel(
      profile.settings.get(settings).preferredThinkingByModel[familyModel.encodedId],
      familyModel.thinkingLevels,
    );
  };

  const applyModelDefaults = (model: string, settings: unknown): void => {
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
      return;
    }

    const settingsBag = settings as Record<string, unknown>;
    if (!profile.models.decodeModelId(model)) {
      settingsBag.effortLevel = 'off';
      return;
    }

    settingsBag.model = model;
    settingsBag.effortLevel = getDefaultReasoningValue(model, settingsBag);
  };

  const applyModelProjectionDefaults = (model: string, settings: unknown): void => {
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
      return;
    }

    const settingsBag = settings as Record<string, unknown>;
    const preferredThinkingLevel = profile.settings.get(settingsBag).preferredThinkingByModel[model];
    if (preferredThinkingLevel) {
      settingsBag.effortLevel = preferredThinkingLevel;
    }
  };

  const buildModelOption = (
    model: PiDiscoveredModel,
    alias: string | undefined,
  ): ProviderUIOption => {
    return {
      description: `${model.provider} runtime`,
      group: model.provider,
      label: alias ?? model.label,
      value: model.encodedId,
    };
  };

  const formatFallbackLabel = (encodedId: string): string => {
    const decoded = profile.models.decodeModelId(encodedId);
    return decoded ? `${decoded.provider}/${decoded.modelId}` : profile.displayName;
  };

  const pushOption = (
    target: ProviderUIOption[],
    seenValues: Set<string>,
    value: string,
    option: ProviderUIOption,
  ): void => {
    if (seenValues.has(value)) {
      return;
    }

    seenValues.add(value);
    target.push(option);
  };

  return {
    getModelOptions(settings): ProviderUIOption[] {
      const familySettings = profile.settings.get(settings);
      const discoveredModels = new Map(familySettings.discoveredModels.map((model) => [
        model.encodedId,
        buildModelOption(model, familySettings.modelAliases[model.encodedId]),
      ]));
      const options: ProviderUIOption[] = [];
      const seen = new Set<string>();
      for (const encodedId of [...familySettings.visibleModels].reverse()) {
        pushOption(
          options,
          seen,
          encodedId,
          discoveredModels.get(encodedId)
            ?? {
              description: 'Configured model',
              label: familySettings.modelAliases[encodedId] ?? formatFallbackLabel(encodedId),
              value: encodedId,
            },
        );
      }

      return options;
    },

    getDefaultModel(settings: Record<string, unknown>): string | null {
      return profile.settings.get(settings).visibleModels[0] ?? null;
    },

    ownsModel(model: string): boolean {
      return profile.models.isModelSelectionId(model);
    },

    isAdaptiveReasoningModel(model: string, settings: Record<string, unknown>): boolean {
      const familyModel = getCachedModel(model, settings);
      if (familyModel) {
        return familyModel.thinkingLevels.some(level => level !== 'off');
      }

      return !!profile.models.decodeModelId(model);
    },

    getReasoningOptions(model: string, settings: Record<string, unknown>): ProviderReasoningOption[] {
      const familyModel = getCachedModel(model, settings);
      const levels = familyModel?.thinkingLevels
        ?? (profile.models.decodeModelId(model) ? defaultReasoningLevels : ['off']);
      return levels.map((level) => ({
        label: formatReasoningValueLabel(level),
        value: level,
      }));
    },

    getDefaultReasoningValue: getDefaultReasoningValue,

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
      return profile.models.isModelSelectionId(model);
    },

    applyModelDefaults,

    applyModelProjectionDefaults,

    applyReasoningSelection(model: string, value: string, settings: unknown): void {
      if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
        return;
      }

      const settingsBag = settings as Record<string, unknown>;
      const familyModel = getCachedModel(model, settingsBag);
      const encodedId = familyModel?.encodedId ?? (profile.models.decodeModelId(model) ? model : '');
      if (!encodedId) {
        return;
      }
      const supportedLevels = familyModel?.thinkingLevels ?? defaultReasoningLevels;

      const nextPreferredThinkingByModel = {
        ...profile.settings.get(settingsBag).preferredThinkingByModel,
      };
      const normalizedValue = value as PiThinkingLevel;
      if (!supportedLevels.includes(normalizedValue)) {
        delete nextPreferredThinkingByModel[encodedId];
      } else {
        nextPreferredThinkingByModel[encodedId] = normalizedValue;
      }

      profile.settings.update(settingsBag, {
        preferredThinkingByModel: nextPreferredThinkingByModel,
      });
    },

    normalizeModelVariant(model: string): string {
      return profile.models.decodeModelId(model) ? model : model;
    },

    getCustomModelIds(): Set<string> {
      return new Set<string>();
    },

    getModeSelector(): null {
      return null;
    },

    getPermissionModeToggle(): ProviderPermissionModeToggleConfig {
      return PI_FAMILY_PERMISSION_MODE_TOGGLE;
    },

    resolvePermissionMode(settings: Record<string, unknown>): string | null {
      return profile.settings.get(settings).toolMode === 'readonly' ? 'normal' : 'yolo';
    },

    applyPermissionMode(value: string, settings: unknown): void {
      if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
        return;
      }

      const settingsBag = settings as Record<string, unknown>;
      settingsBag.permissionMode = value;
      profile.settings.update(settingsBag, {
        toolMode: value === 'normal' ? 'readonly' : 'all',
      });
    },

    getProviderIcon() {
      return options.icon;
    },
  };
}

