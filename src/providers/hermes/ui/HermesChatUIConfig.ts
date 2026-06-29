import type {
  ProviderChatUIConfig,
  ProviderReasoningOption,
  ProviderUIOption,
} from '../../../core/providers/types';
import {
  decodeHermesModelId,
  encodeHermesModelId,
  HERMES_DEFAULT_THINKING_LEVEL,
  isHermesModelSelectionId,
  resolveHermesBaseModelRawId,
} from '../models';
import { getHermesProviderSettings } from '../settings';

const HERMES_MODELS: ProviderUIOption[] = [
  { value: 'hermes', label: 'Hermes', description: 'ACP runtime' },
];
const DEFAULT_CONTEXT_WINDOW = 128_000;

export const hermesChatUIConfig: ProviderChatUIConfig = {
  getModelOptions(settings): ProviderUIOption[] {
    const hermesSettings = getHermesProviderSettings(settings);
    const applyAlias = (rawId: string, option: ProviderUIOption): ProviderUIOption => {
      const alias = hermesSettings.modelAliases[rawId];
      return alias ? { ...option, label: alias } : option;
    };

    const seenValues = new Set<string>();
    const options: ProviderUIOption[] = [];

    for (const rawModelId of hermesSettings.visibleModels) {
      const encodedModelId = encodeHermesModelId(rawModelId);
      pushOption(
        options,
        seenValues,
        encodedModelId,
        applyAlias(rawModelId, {
          description: 'Hermes model',
          label: rawModelId,
          value: encodedModelId,
        }),
      );
    }

    // Ensure currently selected model appears even if not in visible list
    const selectedModel = typeof settings.model === 'string' ? settings.model : '';
    const rawModelId = decodeHermesModelId(selectedModel);
    if (rawModelId && isHermesModelSelectionId(selectedModel)) {
      const baseRawId = resolveHermesBaseModelRawId(rawModelId);
      const baseModelId = encodeHermesModelId(baseRawId);
      pushOption(
        options,
        seenValues,
        baseModelId,
        applyAlias(baseRawId, {
          description: 'Selected model',
          label: baseRawId,
          value: baseModelId,
        }),
      );
    }

    return options.length > 0 ? options : [...HERMES_MODELS];
  },

  ownsModel(model: string): boolean {
    return isHermesModelSelectionId(model);
  },

  isAdaptiveReasoningModel(): boolean {
    return false;
  },

  getReasoningOptions(): ProviderReasoningOption[] {
    return [];
  },

  getDefaultReasoningValue(): string {
    return HERMES_DEFAULT_THINKING_LEVEL;
  },

  getContextWindowSize(model: string, customLimits?: Record<string, number>): number {
    return customLimits?.[model] ?? DEFAULT_CONTEXT_WINDOW;
  },

  isDefaultModel(model: string): boolean {
    return isHermesModelSelectionId(model);
  },

  applyModelDefaults(model: string, settings: unknown): void {
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
      return;
    }

    const settingsBag = settings as Record<string, unknown>;
    const rawModelId = decodeHermesModelId(model);
    if (!rawModelId) {
      settingsBag.effortLevel = HERMES_DEFAULT_THINKING_LEVEL;
      return;
    }

    const baseRawId = resolveHermesBaseModelRawId(rawModelId);
    settingsBag.model = encodeHermesModelId(baseRawId);
    settingsBag.effortLevel = HERMES_DEFAULT_THINKING_LEVEL;
  },

  normalizeModelVariant(model: string, settings: Record<string, unknown>): string {
    const rawModelId = decodeHermesModelId(model);
    if (!rawModelId) {
      return model;
    }

    const baseRawId = resolveHermesBaseModelRawId(rawModelId);
    return encodeHermesModelId(baseRawId);
  },

  getCustomModelIds(): Set<string> {
    return new Set<string>();
  },
};

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
