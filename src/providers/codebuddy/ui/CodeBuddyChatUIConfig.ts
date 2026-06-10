import type {
  ProviderChatUIConfig,
  ProviderPermissionModeToggleConfig,
  ProviderReasoningOption,
  ProviderUIOption,
} from '../../../core/providers/types';
import {
  buildCodeBuddyModelOption,
  CODEBUDDY_DEFAULT_CONTEXT_WINDOW,
  CODEBUDDY_DEFAULT_REASONING_LEVEL,
  CODEBUDDY_DEFAULT_REASONING_OPTIONS,
  CODEBUDDY_MODEL_PREFIX,
  CODEBUDDY_SYNTHETIC_MODEL_ID,
  decodeCodeBuddyModelId,
  encodeCodeBuddyModelId,
  formatCodeBuddyModelLabel,
  isCodeBuddyModelSelectionId,
} from '../models';
import {
  getCodeBuddyProviderSettings,
  resolveCodeBuddyPreferredThinking,
  updateCodeBuddyProviderSettings,
} from '../settings';

const CODEBUDDY_MODELS: ProviderUIOption[] = [
  { value: CODEBUDDY_SYNTHETIC_MODEL_ID, label: 'CodeBuddy', description: 'Use CodeBuddy Code CLI default model' },
];

const CODEBUDDY_PERMISSION_MODE_TOGGLE: ProviderPermissionModeToggleConfig = {
  inactiveValue: 'normal',
  inactiveLabel: 'Ask',
  activeValue: 'yolo',
  activeLabel: 'Bypass',
  planValue: 'plan',
  planLabel: 'Plan',
};

export const codeBuddyChatUIConfig: ProviderChatUIConfig = {
  getModelOptions(settings): ProviderUIOption[] {
    const codeBuddySettings = getCodeBuddyProviderSettings(settings);
    const discoveredModels = new Map(codeBuddySettings.discoveredModels.map((model) => [
      model.rawId,
      buildCodeBuddyModelOption(model, codeBuddySettings.modelAliases[model.rawId]),
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
    for (const rawId of codeBuddySettings.visibleModels) {
      const value = encodeCodeBuddyModelId(rawId);
      pushOption(options, seen, value, discoveredModels.get(rawId) ?? {
        description: 'Configured CodeBuddy model',
        label: codeBuddySettings.modelAliases[rawId] ?? formatCodeBuddyModelLabel(rawId),
        value,
      });
    }

    const selectedValues = [
      typeof settings.model === 'string' ? settings.model : '',
      typeof savedProviderModel?.codebuddy === 'string' ? savedProviderModel.codebuddy : '',
    ];
    for (const selection of selectedValues) {
      const rawId = decodeCodeBuddyModelId(selection);
      if (!rawId) {
        continue;
      }
      const value = encodeCodeBuddyModelId(rawId);
      pushOption(options, seen, value, discoveredModels.get(rawId) ?? {
        description: 'Selected in an existing session',
        label: codeBuddySettings.modelAliases[rawId] ?? formatCodeBuddyModelLabel(rawId),
        value,
      });
    }

    return options.length > 0 ? options : [...CODEBUDDY_MODELS];
  },

  ownsModel(model: string): boolean {
    return isCodeBuddyModelSelectionId(model);
  },

  isAdaptiveReasoningModel(model: string): boolean {
    return model === CODEBUDDY_SYNTHETIC_MODEL_ID || decodeCodeBuddyModelId(model) !== null;
  },

  getReasoningOptions(): ProviderReasoningOption[] {
    return CODEBUDDY_DEFAULT_REASONING_OPTIONS;
  },

  getDefaultReasoningValue(model: string, settings: Record<string, unknown>): string {
    return resolveCodeBuddyPreferredThinking(getCodeBuddyProviderSettings(settings), decodeCodeBuddyModelId(model));
  },

  getContextWindowSize(model: string, customLimits?: Record<string, number>): number {
    return customLimits?.[model] ?? CODEBUDDY_DEFAULT_CONTEXT_WINDOW;
  },

  isDefaultModel(model: string): boolean {
    return model === CODEBUDDY_SYNTHETIC_MODEL_ID || model.startsWith(CODEBUDDY_MODEL_PREFIX);
  },

  applyModelDefaults(model: string, settings: unknown): void {
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
      return;
    }
    const settingsBag = settings as Record<string, unknown>;
    settingsBag.model = model;
    settingsBag.effortLevel = this.getDefaultReasoningValue(model, settingsBag);
  },

  applyReasoningSelection(model: string, value: string, settings: unknown): void {
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
      return;
    }
    const rawId = decodeCodeBuddyModelId(model);
    if (!rawId) {
      return;
    }
    const settingsBag = settings as Record<string, unknown>;
    updateCodeBuddyProviderSettings(settingsBag, {
      preferredThinkingByModel: {
        ...getCodeBuddyProviderSettings(settingsBag).preferredThinkingByModel,
        [rawId]: value || CODEBUDDY_DEFAULT_REASONING_LEVEL,
      },
    });
  },

  normalizeModelVariant(model: string): string {
    return model;
  },

  getCustomModelIds(): Set<string> {
    return new Set<string>();
  },

  getPermissionModeToggle(): ProviderPermissionModeToggleConfig {
    return CODEBUDDY_PERMISSION_MODE_TOGGLE;
  },

  resolvePermissionMode(settings: Record<string, unknown>): string | null {
    return typeof settings.permissionMode === 'string' ? settings.permissionMode : null;
  },

  applyPermissionMode(value: string, settings: unknown): void {
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
      return;
    }
    (settings as Record<string, unknown>).permissionMode = value;
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
