import { getRuntimeEnvironmentVariables } from '../../../core/providers/providerEnvironment';
import type {
  ProviderChatUIConfig,
  ProviderPermissionModeToggleConfig,
  ProviderReasoningOption,
  ProviderUIOption,
} from '../../../core/providers/types';

const CURSOR_MODELS: ProviderUIOption[] = [
  { value: 'auto', label: 'Auto' },
  { value: 'composer-2-fast', label: 'Composer 2 Fast' },
  { value: 'composer-2', label: 'Composer 2' },
  { value: 'composer-1.5', label: 'Composer 1.5' },
];

const CURSOR_MODEL_SET = new Set(CURSOR_MODELS.map(m => m.value));

const CURSOR_PERMISSION_MODE_TOGGLE: ProviderPermissionModeToggleConfig = {
  inactiveValue: 'normal',
  inactiveLabel: 'Safe',
  activeValue: 'yolo',
  activeLabel: 'YOLO',
  planValue: 'plan',
  planLabel: 'Plan',
};

const DEFAULT_CONTEXT_WINDOW = 200_000;

const REASONING_OFF: ProviderReasoningOption[] = [
  { value: 'off', label: 'Off' },
];

export const cursorChatUIConfig: ProviderChatUIConfig = {
  getModelOptions(settings: Record<string, unknown>): ProviderUIOption[] {
    const envVars = getRuntimeEnvironmentVariables(settings, 'cursor');
    if (envVars.CURSOR_MODEL && !CURSOR_MODEL_SET.has(envVars.CURSOR_MODEL)) {
      return [
        { value: envVars.CURSOR_MODEL, label: envVars.CURSOR_MODEL, description: 'Custom (env)' },
        ...CURSOR_MODELS,
      ];
    }
    return [...CURSOR_MODELS];
  },

  ownsModel(model: string, settings: Record<string, unknown>): boolean {
    if (this.getModelOptions(settings).some((option: ProviderUIOption) => option.value === model)) {
      return true;
    }
    return /^composer-/i.test(model);
  },

  isAdaptiveReasoningModel(): boolean {
    return false;
  },

  getReasoningOptions(): ProviderReasoningOption[] {
    return [...REASONING_OFF];
  },

  getDefaultReasoningValue(): string {
    return 'off';
  },

  getContextWindowSize(): number {
    return DEFAULT_CONTEXT_WINDOW;
  },

  isDefaultModel(model: string): boolean {
    return CURSOR_MODEL_SET.has(model);
  },

  applyModelDefaults(): void {},

  normalizeModelVariant(model: string): string {
    if (model === 'composer-1') {
      return 'auto';
    }
    return model;
  },

  getCustomModelIds(envVars: Record<string, string>): Set<string> {
    const ids = new Set<string>();
    if (envVars.CURSOR_MODEL && !CURSOR_MODEL_SET.has(envVars.CURSOR_MODEL)) {
      ids.add(envVars.CURSOR_MODEL);
    }
    return ids;
  },

  getPermissionModeToggle(): ProviderPermissionModeToggleConfig {
    return CURSOR_PERMISSION_MODE_TOGGLE;
  },

  isBangBashEnabled(): boolean {
    return false;
  },
};
