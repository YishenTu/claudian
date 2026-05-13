import type {
  ProviderChatUIConfig,
  ProviderPermissionModeToggleConfig,
  ProviderReasoningOption,
  ProviderServiceTierToggleConfig,
  ProviderUIOption,
} from '../../../core/providers/types';
import { OPENAI_PROVIDER_ICON } from '../../../shared/icons';
import { getCodexModelOptions } from '../modelOptions';
import { applyCodexModelDefaults } from '../settings';
import {
  DEFAULT_CODEX_MODEL_SET,
  DEFAULT_CODEX_PRIMARY_MODEL,
  FAST_TIER_CODEX_DESCRIPTION,
  FAST_TIER_CODEX_MODEL,
} from '../types/models';

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
  description: FAST_TIER_CODEX_DESCRIPTION,
};

const DEFAULT_CONTEXT_WINDOW = 200_000;

function looksLikeCodexModel(model: string): boolean {
  return /^gpt-/i.test(model) || /^o\d/i.test(model);
}

export const codexChatUIConfig: ProviderChatUIConfig = {
  getModelOptions(settings: Record<string, unknown>): ProviderUIOption[] {
    return getCodexModelOptions(settings);
  },

  ownsModel(model: string, settings: Record<string, unknown>): boolean {
    if (getCodexModelOptions(settings).some((option: ProviderUIOption) => option.value === model)) {
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
    return DEFAULT_CODEX_MODEL_SET.has(model);
  },

  applyModelDefaults(model: string, settings: unknown): void {
    if (!settings || typeof settings !== 'object') {
      return;
    }

    applyCodexModelDefaults(model, settings as Record<string, unknown>);
  },

  normalizeModelVariant(model: string, settings: Record<string, unknown>): string {
    if (getCodexModelOptions(settings).some((option) => option.value === model)) {
      return model;
    }

    return DEFAULT_CODEX_PRIMARY_MODEL;
  },

  getCustomModelIds(envVars: Record<string, string>): Set<string> {
    const ids = new Set<string>();
    if (envVars.OPENAI_MODEL && !DEFAULT_CODEX_MODEL_SET.has(envVars.OPENAI_MODEL)) {
      ids.add(envVars.OPENAI_MODEL);
    }
    return ids;
  },

  getPermissionModeToggle(): ProviderPermissionModeToggleConfig {
    return CODEX_PERMISSION_MODE_TOGGLE;
  },

  getServiceTierToggle(settings): ProviderServiceTierToggleConfig | null {
    return settings.model === FAST_TIER_CODEX_MODEL ? CODEX_SERVICE_TIER_TOGGLE : null;
  },

  getProviderIcon() {
    return OPENAI_PROVIDER_ICON;
  },
};
