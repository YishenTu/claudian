import { getRuntimeEnvironmentVariables } from '../../../core/providers/providerEnvironment';
import type {
  ProviderChatUIConfig,
  ProviderPermissionModeToggleConfig,
  ProviderReasoningOption,
  ProviderServiceTierToggleConfig,
  ProviderUIOption,
} from '../../../core/providers/types';
import { OPENAI_PROVIDER_ICON } from '../../../shared/icons';

const CODEX_MODELS: ProviderUIOption[] = [
  { value: 'gpt-5.4-mini', label: 'GPT-5.4 Mini', description: 'Fast' },
  { value: 'gpt-5.4', label: 'GPT-5.4', description: 'Latest' },
];

const CODEX_MODEL_SET = new Set(CODEX_MODELS.map(m => m.value));

const EFFORT_LEVELS: ProviderReasoningOption[] = [
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'xhigh', label: 'XHigh' },
];

const CODEX_PERMISSION_MODE_TOGGLE: ProviderPermissionModeToggleConfig = {
  inactiveValue: 'normal',
  inactiveLabel: 'Safe',
  activeValue: 'yolo',
  activeLabel: 'YOLO',
  planValue: 'plan',
  planLabel: 'Plan',
};

const CODEX_SERVICE_TIER_TOGGLE: ProviderServiceTierToggleConfig = {
  inactiveValue: 'default',
  inactiveLabel: 'Standard',
  activeValue: 'fast',
  activeLabel: 'Fast',
  description: 'Enable GPT-5.4 fast mode for this conversation. Faster responses use more credits.',
};

const DEFAULT_CONTEXT_WINDOW = 200_000;

function looksLikeCodexModel(model: string): boolean {
  return /^gpt-/i.test(model) || /^o\d/i.test(model);
}

export const codexChatUIConfig: ProviderChatUIConfig = {
  getModelOptions(settings: Record<string, unknown>): ProviderUIOption[] {
    const envVars = getRuntimeEnvironmentVariables(settings, 'codex');
    if (envVars.OPENAI_MODEL) {
      const customModel = envVars.OPENAI_MODEL;
      if (!CODEX_MODEL_SET.has(customModel)) {
        return [
          { value: customModel, label: customModel, description: 'Custom (env)' },
          ...CODEX_MODELS,
        ];
      }
    }
    return [...CODEX_MODELS];
  },

  ownsModel(model: string, settings: Record<string, unknown>): boolean {
    if (this.getModelOptions(settings).some((option: ProviderUIOption) => option.value === model)) {
      return true;
    }

    return looksLikeCodexModel(model);
  },

  isAdaptiveReasoningModel(_model: string, _settings: Record<string, unknown>): boolean {
    return true;
  },

  getReasoningOptions(_model: string, _settings: Record<string, unknown>): ProviderReasoningOption[] {
    return [...EFFORT_LEVELS];
  },

  getDefaultReasoningValue(_model: string, _settings: Record<string, unknown>): string {
    return 'medium';
  },

  getContextWindowSize(): number {
    return DEFAULT_CONTEXT_WINDOW;
  },

  isDefaultModel(model: string): boolean {
    return CODEX_MODEL_SET.has(model);
  },

  applyModelDefaults(): void {
    // No-op for Codex
  },

  normalizeModelVariant(model: string): string {
    return model;
  },

  getCustomModelIds(envVars: Record<string, string>): Set<string> {
    const ids = new Set<string>();
    if (envVars.OPENAI_MODEL && !CODEX_MODEL_SET.has(envVars.OPENAI_MODEL)) {
      ids.add(envVars.OPENAI_MODEL);
    }
    return ids;
  },

  getPermissionModeToggle(): ProviderPermissionModeToggleConfig {
    return CODEX_PERMISSION_MODE_TOGGLE;
  },

  getServiceTierToggle(settings): ProviderServiceTierToggleConfig | null {
    return settings.model === 'gpt-5.4' ? CODEX_SERVICE_TIER_TOGGLE : null;
  },

  getProviderIcon() {
    return OPENAI_PROVIDER_ICON;
  },
};
