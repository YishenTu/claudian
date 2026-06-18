import type {
  ProviderChatUIConfig,
  ProviderPermissionModeToggleConfig,
  ProviderReasoningOption,
  ProviderUIOption,
} from '../../../core/providers/types';
import { CLAUDE_PROVIDER_ICON } from '../../../shared/icons';
import { getCustomModelIds } from '../env/claudeModelEnv';
import { getClaudeModelOptions } from '../modelOptions';
import { toClaudeRuntimeModelId } from '../modelSelection';
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
    const runtimeModel = toClaudeRuntimeModelId(model);
    return getClaudeModelOptions(settings).some((option: ProviderUIOption) =>
      option.value === model || toClaudeRuntimeModelId(option.value) === runtimeModel
    );
  },

  isAdaptiveReasoningModel(_model: string, _settings: Record<string, unknown>): boolean {
    return true;
  },

  getReasoningOptions(model: string, _settings: Record<string, unknown>): ProviderReasoningOption[] {
    const runtimeModel = toClaudeRuntimeModelId(model);
    const levels = supportsXHighEffort(runtimeModel)
      ? EFFORT_LEVELS
      : EFFORT_LEVELS.filter(e => e.value !== 'xhigh');
    return levels.map(e => ({ value: e.value, label: e.label }));
  },

  getDefaultReasoningValue(model: string, _settings: Record<string, unknown>): string {
    return DEFAULT_EFFORT_LEVEL[toClaudeRuntimeModelId(model)] ?? 'high';
  },

  getContextWindowSize(model: string, customLimits?: Record<string, number>): number {
    return getContextWindowSize(toClaudeRuntimeModelId(model), customLimits);
  },

  isDefaultModel(model: string): boolean {
    const runtimeModel = toClaudeRuntimeModelId(model);
    return DEFAULT_CLAUDE_MODELS.some(m => m.value === runtimeModel);
  },

  applyModelDefaults(model: string, settings: unknown): void {
    const target = settings as Record<string, unknown>;

    const runtimeModel = toClaudeRuntimeModelId(model);
    if (DEFAULT_CLAUDE_MODELS.some(m => m.value === runtimeModel)) {
      target.effortLevel = DEFAULT_EFFORT_LEVEL[runtimeModel] ?? 'high';
      updateClaudeProviderSettings(target, { lastModel: runtimeModel });
    } else {
      target.lastCustomModel = model;
      target.effortLevel = normalizeEffortLevel(runtimeModel, target.effortLevel);
    }
  },

  normalizeModelVariant(model: string, settings) {
    const claudeSettings = getClaudeProviderSettings(settings);
    const normalizedRuntimeModel = normalizeVisibleModelVariant(
      toClaudeRuntimeModelId(model),
      claudeSettings.enableOpus1M,
      claudeSettings.enableSonnet1M,
    );
    const option = getClaudeModelOptions(settings).find(candidate =>
      candidate.value === normalizedRuntimeModel
      || toClaudeRuntimeModelId(candidate.value) === normalizedRuntimeModel
    );
    return option?.value ?? normalizedRuntimeModel;
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
