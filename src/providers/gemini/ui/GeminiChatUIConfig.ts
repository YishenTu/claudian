import type {
  ProviderChatUIConfig,
  ProviderIconSvg,
  ProviderPermissionModeToggleConfig,
  ProviderReasoningOption,
  ProviderUIOption,
} from '../../../core/providers/types';
import { getGeminiModelOptions } from '../modelOptions';
import {
  DEFAULT_GEMINI_CONTEXT_WINDOW,
  DEFAULT_GEMINI_MODEL_SET,
  DEFAULT_GEMINI_PRIMARY_MODEL,
} from '../types/models';

const GEMINI_ICON: ProviderIconSvg = {
  viewBox: '0 0 24 24',
  path: 'M12 2l1.7 5.2L19 9l-5.3 1.8L12 16l-1.7-5.2L5 9l5.3-1.8L12 2zm6 10l.9 2.6 2.6.9-2.6.9L18 19l-.9-2.6-2.6-.9 2.6-.9L18 12zM6 14l.7 2.1 2.1.7-2.1.7L6 20l-.7-2.5-2.1-.7 2.1-.7L6 14z',
};

const HIDDEN_REASONING_OPTIONS: ProviderReasoningOption[] = [
  { value: 'none', label: 'None' },
];

const GEMINI_PERMISSION_MODE_TOGGLE: ProviderPermissionModeToggleConfig = {
  inactiveValue: 'normal',
  inactiveLabel: 'Ask',
  activeValue: 'yolo',
  activeLabel: 'YOLO',
};

function looksLikeGeminiModel(model: string): boolean {
  return /^gemini-/i.test(model) || /^models\/gemini-/i.test(model);
}

export const geminiChatUIConfig: ProviderChatUIConfig = {
  getModelOptions(settings: Record<string, unknown>): ProviderUIOption[] {
    return getGeminiModelOptions(settings);
  },

  ownsModel(model: string, settings: Record<string, unknown>): boolean {
    if (this.getModelOptions(settings).some((option: ProviderUIOption) => option.value === model)) {
      return true;
    }

    return looksLikeGeminiModel(model);
  },

  isAdaptiveReasoningModel(): boolean {
    return false;
  },

  getReasoningOptions(): ProviderReasoningOption[] {
    return [...HIDDEN_REASONING_OPTIONS];
  },

  getDefaultReasoningValue(): string {
    return 'none';
  },

  getContextWindowSize(model: string, customLimits?: Record<string, number>): number {
    return customLimits?.[model] ?? DEFAULT_GEMINI_CONTEXT_WINDOW;
  },

  isDefaultModel(model: string): boolean {
    return DEFAULT_GEMINI_MODEL_SET.has(model);
  },

  applyModelDefaults(): void {
    // No-op for Gemini API models.
  },

  normalizeModelVariant(model: string, settings: Record<string, unknown>): string {
    if (getGeminiModelOptions(settings).some((option) => option.value === model)) {
      return model;
    }

    return DEFAULT_GEMINI_PRIMARY_MODEL;
  },

  getCustomModelIds(envVars: Record<string, string>): Set<string> {
    const ids = new Set<string>();
    const envModel = envVars.GEMINI_MODEL || envVars.GOOGLE_GEMINI_MODEL;
    if (envModel && !DEFAULT_GEMINI_MODEL_SET.has(envModel)) {
      ids.add(envModel);
    }
    return ids;
  },

  getPermissionModeToggle(): ProviderPermissionModeToggleConfig {
    return GEMINI_PERMISSION_MODE_TOGGLE;
  },

  getProviderIcon() {
    return GEMINI_ICON;
  },
};
