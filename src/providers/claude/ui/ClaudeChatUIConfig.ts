import type {
  ProviderChatUIConfig,
  ProviderPermissionModeToggleConfig,
  ProviderReasoningOption,
  ProviderUIOption,
} from '../../../core/providers/types';
import { parseEnvironmentVariables } from '../../../utils/env';
import { getCustomModelIds, getModelsFromEnvironment } from '../env/claudeModelEnv';
import {
  type ClaudeModel,
  type ClaudianSettings,
  DEFAULT_CLAUDE_MODELS,
  DEFAULT_EFFORT_LEVEL,
  DEFAULT_THINKING_BUDGET,
  EFFORT_LEVELS,
  filterVisibleModelOptions,
  getContextWindowSize,
  isAdaptiveThinkingModel,
  normalizeVisibleModelVariant,
  THINKING_BUDGETS,
} from '../types';

const CLAUDE_PERMISSION_MODE_TOGGLE: ProviderPermissionModeToggleConfig = {
  inactiveValue: 'normal',
  inactiveLabel: 'Safe',
  activeValue: 'yolo',
  activeLabel: 'YOLO',
  planValue: 'plan',
  planLabel: 'PLAN',
};

export const claudeChatUIConfig: ProviderChatUIConfig = {
  getModelOptions(settings) {
    const envVars = settings.environmentVariables as string | undefined;
    if (envVars) {
      const parsed = parseEnvironmentVariables(envVars);
      const customModels = getModelsFromEnvironment(parsed);
      if (customModels.length > 0) {
        return customModels;
      }
    }

    const models = [...DEFAULT_CLAUDE_MODELS];
    return filterVisibleModelOptions(
      models,
      (settings.enableOpus1M as boolean) ?? false,
      (settings.enableSonnet1M as boolean) ?? false,
    );
  },

  isAdaptiveReasoningModel(model: string): boolean {
    return isAdaptiveThinkingModel(model);
  },

  getReasoningOptions(model: string): ProviderReasoningOption[] {
    if (isAdaptiveThinkingModel(model)) {
      return EFFORT_LEVELS.map(e => ({ value: e.value, label: e.label }));
    }
    return THINKING_BUDGETS.map(b => ({ value: b.value, label: b.label, tokens: b.tokens }));
  },

  getDefaultReasoningValue(model: string): string {
    if (isAdaptiveThinkingModel(model)) {
      return DEFAULT_EFFORT_LEVEL[model] ?? 'high';
    }
    return DEFAULT_THINKING_BUDGET[model] ?? 'off';
  },

  getContextWindowSize(model: string, customLimits?: Record<string, number>): number {
    return getContextWindowSize(model, customLimits);
  },

  isDefaultModel(model: string): boolean {
    return DEFAULT_CLAUDE_MODELS.some(m => m.value === model);
  },

  applyModelDefaults(model: string, settings: unknown): void {
    const s = settings as ClaudianSettings;
    if (DEFAULT_CLAUDE_MODELS.some(m => m.value === model)) {
      s.thinkingBudget = DEFAULT_THINKING_BUDGET[model as ClaudeModel];
      if (isAdaptiveThinkingModel(model)) {
        s.effortLevel = DEFAULT_EFFORT_LEVEL[model as ClaudeModel] ?? 'high';
      }
      s.lastClaudeModel = model;
    } else {
      s.lastCustomModel = model;
    }
  },

  normalizeModelVariant(model: string, settings) {
    return normalizeVisibleModelVariant(
      model,
      (settings.enableOpus1M as boolean) ?? false,
      (settings.enableSonnet1M as boolean) ?? false,
    );
  },

  getCustomModelIds(envVars: Record<string, string>): Set<string> {
    return getCustomModelIds(envVars);
  },

  getPermissionModeToggle() {
    return CLAUDE_PERMISSION_MODE_TOGGLE;
  },
};

/** Re-export for type-only use in provider registration. */
export type { ProviderUIOption };
