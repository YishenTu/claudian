import type {
  ProviderChatUIConfig,
  ProviderPermissionModeToggleConfig,
  ProviderReasoningOption,
  ProviderUIOption,
} from '../../../core/providers/types';
import { CLAUDE_PROVIDER_ICON } from '../../../shared/icons';
import { getCustomModelIds } from '../env/claudeModelEnv';
import { getClaudeModelOptions } from '../modelOptions';
import { getClaudeProviderSettings, updateClaudeProviderSettings } from '../settings';
import {
  type ClaudeModel,
  DEFAULT_CLAUDE_MODELS,
  DEFAULT_EFFORT_LEVEL,
  DEFAULT_THINKING_BUDGET,
  EFFORT_LEVELS,
  getContextWindowSize,
  isAdaptiveThinkingModel,
  normalizeEffortLevel,
  normalizeVisibleModelVariant,
  supportsXHighEffort,
  THINKING_BUDGETS,
} from '../types/models';

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
    return getClaudeModelOptions(settings);
  },

  ownsModel(model: string, settings: Record<string, unknown>): boolean {
    return this.getModelOptions(settings).some((option: ProviderUIOption) => option.value === model);
  },

  isAdaptiveReasoningModel(model: string, _settings: Record<string, unknown>): boolean {
    return isAdaptiveThinkingModel(model);
  },

  getReasoningOptions(model: string, _settings: Record<string, unknown>): ProviderReasoningOption[] {
    if (isAdaptiveThinkingModel(model)) {
      const levels = supportsXHighEffort(model)
        ? EFFORT_LEVELS
        : EFFORT_LEVELS.filter(e => e.value !== 'xhigh');
      return levels.map(e => ({ value: e.value, label: e.label }));
    }
    return THINKING_BUDGETS.map(b => ({ value: b.value, label: b.label, tokens: b.tokens }));
  },

  getDefaultReasoningValue(model: string, _settings: Record<string, unknown>): string {
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
    const target = settings as Record<string, unknown>;

    if (DEFAULT_CLAUDE_MODELS.some(m => m.value === model)) {
      target.thinkingBudget = DEFAULT_THINKING_BUDGET[model as ClaudeModel];
      if (isAdaptiveThinkingModel(model)) {
        target.effortLevel = DEFAULT_EFFORT_LEVEL[model as ClaudeModel] ?? 'high';
      }
      updateClaudeProviderSettings(target, { lastModel: model });
    } else {
      target.lastCustomModel = model;
      if (isAdaptiveThinkingModel(model)) {
        target.effortLevel = normalizeEffortLevel(model, target.effortLevel as string | undefined);
      }
    }
  },

  normalizeModelVariant(model: string, settings) {
    const claudeSettings = getClaudeProviderSettings(settings);
    return normalizeVisibleModelVariant(
      model,
      claudeSettings.enableOpus1M,
      claudeSettings.enableSonnet1M,
    );
  },

  getCustomModelIds(envVars: Record<string, string>): Set<string> {
    return getCustomModelIds(envVars);
  },

  getPermissionModeToggle() {
    return CLAUDE_PERMISSION_MODE_TOGGLE;
  },

  isBangBashEnabled(settings) {
    return getClaudeProviderSettings(settings).enableBangBash;
  },

  getProviderIcon() {
    return CLAUDE_PROVIDER_ICON;
  },
};

/** Re-export for type-only use in provider registration. */
export type { ProviderUIOption };
