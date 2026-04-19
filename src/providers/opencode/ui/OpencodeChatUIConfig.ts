import type {
  ProviderChatUIConfig,
  ProviderReasoningOption,
  ProviderUIOption,
} from '../../../core/providers/types';
import {
  decodeOpencodeModelId,
  encodeOpencodeModelId,
  isOpencodeModelSelectionId,
  OPENCODE_SYNTHETIC_MODEL_ID,
} from '../models';
import { getOpencodeProviderSettings } from '../settings';

const OPENCODE_MODELS: ProviderUIOption[] = [
  { value: OPENCODE_SYNTHETIC_MODEL_ID, label: 'OpenCode', description: 'ACP runtime' },
];
const OPENCODE_REASONING_OPTIONS: ProviderReasoningOption[] = [
  { value: 'off', label: 'Off' },
];
const DEFAULT_CONTEXT_WINDOW = 200_000;

export const opencodeChatUIConfig: ProviderChatUIConfig = {
  getModelOptions(settings): ProviderUIOption[] {
    const opencodeSettings = getOpencodeProviderSettings(settings);
    const discoveredModels = new Map(opencodeSettings.discoveredModels.map((model) => [
      encodeOpencodeModelId(model.rawId),
      {
        description: model.description ?? 'ACP runtime',
        label: model.label,
        value: encodeOpencodeModelId(model.rawId),
      } satisfies ProviderUIOption,
    ]));
    const savedProviderModel = (
      settings.savedProviderModel
      && typeof settings.savedProviderModel === 'object'
      && !Array.isArray(settings.savedProviderModel)
    )
      ? settings.savedProviderModel as Record<string, unknown>
      : null;

    const selectedModelValues = [
      typeof settings.model === 'string' ? settings.model : '',
      typeof savedProviderModel?.opencode === 'string'
        ? savedProviderModel.opencode
        : '',
    ];

    const seenValues = new Set<string>();
    const options: ProviderUIOption[] = [];
    for (const model of selectedModelValues) {
      if (
        !model
        || !isOpencodeModelSelectionId(model)
        || model === OPENCODE_SYNTHETIC_MODEL_ID
      ) {
        continue;
      }

      pushOption(
        options,
        seenValues,
        model,
        discoveredModels.get(model)
          ?? {
            description: 'Selected in an existing session',
            label: decodeOpencodeModelId(model) ?? model,
            value: model,
          },
      );
    }

    for (const rawModelId of opencodeSettings.visibleModels) {
      const encodedModelId = encodeOpencodeModelId(rawModelId);
      pushOption(
        options,
        seenValues,
        encodedModelId,
        discoveredModels.get(encodedModelId)
          ?? {
            description: 'Configured model',
            label: rawModelId,
            value: encodedModelId,
          },
      );
    }

    return options.length > 0 ? options : [...OPENCODE_MODELS];
  },

  ownsModel(model: string): boolean {
    return isOpencodeModelSelectionId(model);
  },

  isAdaptiveReasoningModel(_model: string): boolean {
    return false;
  },

  getReasoningOptions(_model: string): ProviderReasoningOption[] {
    return [...OPENCODE_REASONING_OPTIONS];
  },

  getDefaultReasoningValue(_model: string): string {
    return 'off';
  },

  getContextWindowSize(model: string, customLimits?: Record<string, number>): number {
    return customLimits?.[model] ?? DEFAULT_CONTEXT_WINDOW;
  },

  isDefaultModel(model: string): boolean {
    return isOpencodeModelSelectionId(model);
  },

  applyModelDefaults(_model: string, _settings: unknown): void {
    // OpenCode MVP exposes a single synthetic model entry.
  },

  normalizeModelVariant(model: string): string {
    return model;
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
