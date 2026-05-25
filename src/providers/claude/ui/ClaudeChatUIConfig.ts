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
  DEFAULT_CLAUDE_MODELS,
  DEFAULT_EFFORT_LEVEL,
  EFFORT_LEVELS,
  getContextWindowSize,
  normalizeEffortLevel,
  normalizeVisibleModelVariant,
  supportsXHighEffort,
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
    return getClaudeModelOptions(settings).some((option: ProviderUIOption) => option.value === model);
  },

  isAdaptiveReasoningModel(_model: string, _settings: Record<string, unknown>): boolean {
    return true;
  },

  getReasoningOptions(model: string, _settings: Record<string, unknown>): ProviderReasoningOption[] {
    const levels = supportsXHighEffort(model)
      ? EFFORT_LEVELS
      : EFFORT_LEVELS.filter(e => e.value !== 'xhigh');
    return levels.map(e => ({ value: e.value, label: e.label }));
  },

  getDefaultReasoningValue(model: string, _settings: Record<string, unknown>): string {
    return DEFAULT_EFFORT_LEVEL[model] ?? 'high';
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
      target.effortLevel = DEFAULT_EFFORT_LEVEL[model] ?? 'high';
      updateClaudeProviderSettings(target, { lastModel: model });
    } else {
      target.lastCustomModel = model;
      target.effortLevel = normalizeEffortLevel(model, target.effortLevel);
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
