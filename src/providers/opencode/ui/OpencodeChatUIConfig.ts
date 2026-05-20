import type {
  ProviderChatUIConfig,
  ProviderPermissionModeToggleConfig,
  ProviderReasoningOption,
  ProviderUIOption,
} from '../../../core/providers/types';
import { OPENCODE_PROVIDER_ICON } from '../../../shared/icons';
import {
  buildOpencodeBaseModels,
  decodeOpencodeModelId,
  encodeOpencodeModelId,
  isOpencodeModelSelectionId,
  OPENCODE_DEFAULT_THINKING_LEVEL,
  OPENCODE_SYNTHETIC_MODEL_ID,
  resolveOpencodeBaseModelRawId,
} from '../models';
import {
  resolveOpencodeModeForPermissionMode,
  resolvePermissionModeForManagedOpencodeMode,
} from '../modes';
import { OpencodeChatRuntime } from '../runtime/OpencodeChatRuntime';
import { getOpencodeProviderSettings, updateOpencodeProviderSettings } from '../settings';

const OPENCODE_MODELS: ProviderUIOption[] = [
  { value: OPENCODE_SYNTHETIC_MODEL_ID, label: 'OpenCode', description: 'ACP runtime' },
];
const DEFAULT_CONTEXT_WINDOW = 200_000;
const OPENCODE_METADATA_WARMUP_DB = ':memory:';
const OPENCODE_PERMISSION_MODE_TOGGLE: ProviderPermissionModeToggleConfig = {
  inactiveValue: 'normal',
  inactiveLabel: 'Safe',
  activeValue: 'yolo',
  activeLabel: 'YOLO',
  planValue: 'plan',
  planLabel: 'Plan',
};

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

  isAdaptiveReasoningModel(model: string, settings: Record<string, unknown>): boolean {
    return getOpencodeThinkingOptions(model, settings).length > 0;
  },

  getReasoningOptions(model: string, settings: Record<string, unknown>): ProviderReasoningOption[] {
    return getOpencodeThinkingOptions(model, settings)
      .map((variant) => ({
        description: variant.description,
        label: variant.label,
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

    const runtime = new OpencodeChatRuntime(context.plugin);
    try {
      runtime.syncConversationState({
        providerState: { databasePath: OPENCODE_METADATA_WARMUP_DB },
        sessionId: null,
      });
      await runtime.warmModelMetadata(model);
    } catch {
      // Metadata warmup is opportunistic; the first real turn can still discover it.
    } finally {
      runtime.cleanup();
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

  getModeSelector(): null {
    return null;
  },

  getPermissionModeToggle(): ProviderPermissionModeToggleConfig {
    return OPENCODE_PERMISSION_MODE_TOGGLE;
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
    (opencodeSettings.thinkingOptionsByModel[baseRawId] ?? []).map((variant) => variant.value),
  );
  if (preferred && supportedValues.has(preferred)) {
    return preferred;
  }

  return opencodeSettings.thinkingOptionsByModel[baseRawId]?.[0]?.value
    ?? OPENCODE_DEFAULT_THINKING_LEVEL;
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
