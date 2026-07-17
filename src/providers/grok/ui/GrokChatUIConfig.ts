import { getRuntimeEnvironmentVariables } from '../../../core/providers/providerEnvironment';
import type {
  ProviderChatUIConfig,
  ProviderPermissionModeToggleConfig,
  ProviderReasoningOption,
  ProviderUIOption,
} from '../../../core/providers/types';
import { XAI_PROVIDER_ICON } from '../../../shared/icons';

/** Default model id from Grok Build 0.2.99 ACP modelState. */
export const GROK_DEFAULT_MODEL = 'grok-4.5';

const GROK_MODELS: ProviderUIOption[] = [
  {
    value: GROK_DEFAULT_MODEL,
    label: 'Grok 4.5',
    description: 'xAI coding agent',
  },
];

const GROK_MODEL_SET = new Set(GROK_MODELS.map((model) => model.value));

/** Effort levels reported by Grok Build 0.2.99 for grok-4.5. */
const GROK_EFFORT_LEVELS: ProviderReasoningOption[] = [
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
];

const GROK_DEFAULT_EFFORT = 'high';
const GROK_DEFAULT_CONTEXT_WINDOW = 500_000;

const GROK_PERMISSION_MODE_TOGGLE: ProviderPermissionModeToggleConfig = {
  inactiveValue: 'normal',
  inactiveLabel: 'Safe',
  activeValue: 'yolo',
  activeLabel: 'YOLO',
  planValue: 'plan',
  planLabel: 'Plan',
};

function looksLikeGrokModel(model: string): boolean {
  return /^grok[-_]/i.test(model);
}

function resolveCustomEnvModel(settings: Record<string, unknown>): string {
  const envVars = getRuntimeEnvironmentVariables(settings, 'grok');
  const customModel = envVars.GROK_MODEL || envVars.XAI_MODEL;
  return typeof customModel === 'string' ? customModel.trim() : '';
}

export const grokChatUIConfig: ProviderChatUIConfig = {
  getModelOptions(settings): ProviderUIOption[] {
    const customModel = resolveCustomEnvModel(settings);
    if (customModel && !GROK_MODEL_SET.has(customModel)) {
      return [
        { value: customModel, label: customModel, description: 'Custom (env)' },
        ...GROK_MODELS,
      ];
    }
    return [...GROK_MODELS];
  },

  getDefaultModel(): string {
    return GROK_DEFAULT_MODEL;
  },

  ownsModel(model: string, settings: Record<string, unknown>): boolean {
    if (this.getModelOptions(settings).some((option) => option.value === model)) {
      return true;
    }
    return looksLikeGrokModel(model);
  },

  isAdaptiveReasoningModel(): boolean {
    return true;
  },

  getReasoningOptions(): ProviderReasoningOption[] {
    return [...GROK_EFFORT_LEVELS];
  },

  getDefaultReasoningValue(): string {
    return GROK_DEFAULT_EFFORT;
  },

  getContextWindowSize(model: string, customLimits?: Record<string, number>): number {
    return customLimits?.[model] ?? GROK_DEFAULT_CONTEXT_WINDOW;
  },

  isDefaultModel(model: string): boolean {
    return GROK_MODEL_SET.has(model);
  },

  applyModelDefaults(): void {},

  normalizeModelVariant(model: string, settings: Record<string, unknown>): string {
    return this.ownsModel(model, settings) ? model : GROK_DEFAULT_MODEL;
  },

  getCustomModelIds(envVars: Record<string, string>): Set<string> {
    const ids = new Set<string>();
    const customModel = (envVars.GROK_MODEL || envVars.XAI_MODEL || '').trim();
    if (customModel && !GROK_MODEL_SET.has(customModel)) {
      ids.add(customModel);
    }
    return ids;
  },

  getPermissionModeToggle(): ProviderPermissionModeToggleConfig {
    return GROK_PERMISSION_MODE_TOGGLE;
  },

  getProviderIcon() {
    return XAI_PROVIDER_ICON;
  },
};
