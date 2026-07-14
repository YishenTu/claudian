import { DEFAULT_REASONING_VALUE } from '../../../core/providers/reasoning';
import type {
  ProviderChatUIConfig,
  ProviderPermissionModeToggleConfig,
  ProviderReasoningOption,
  ProviderUIOption,
} from '../../../core/providers/types';
import { CLAUDE_PROVIDER_ICON } from '../../../shared/icons';
import { getCustomModelIds } from '../env/claudeModelEnv';
import {
  findClaudeModelOption,
  getClaudeModelOptions,
  resolveClaudeModelEnvironmentTypePreference,
} from '../modelOptions';
import { toClaudeRuntimeModelId } from '../modelSelection';
import { isClaudeModelTier } from '../modelTiers';
import { getClaudeProviderSettings, updateClaudeProviderSettings } from '../settings';
import {
  DEFAULT_CLAUDE_MODELS,
  DEFAULT_EFFORT_LEVEL,
  EFFORT_LEVELS,
  getContextWindowSize,
  normalizeEffortLevel,
  normalizeLegacyClaudeModelAlias,
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
    return DEFAULT_EFFORT_LEVEL[toClaudeRuntimeModelId(model)] ?? DEFAULT_REASONING_VALUE;
  },

  getContextWindowSize(model: string, customLimits?: Record<string, number>): number {
    return getContextWindowSize(toClaudeRuntimeModelId(model), customLimits);
  },

  isDefaultModel(model: string): boolean {
    const runtimeModel = normalizeLegacyClaudeModelAlias(toClaudeRuntimeModelId(model));
    return DEFAULT_CLAUDE_MODELS.some(m => m.value === runtimeModel);
  },

  applyModelDefaults(model: string, settings: unknown): void {
    const target = settings as Record<string, unknown>;

    const runtimeModel = normalizeLegacyClaudeModelAlias(toClaudeRuntimeModelId(model));
    const claudeSettings = getClaudeProviderSettings(target);
    const modelEnvironmentType = resolveClaudeModelEnvironmentTypePreference(
      getClaudeModelOptions(target),
      model,
      claudeSettings.modelEnvironmentType,
    );
    if (modelEnvironmentType && isClaudeModelTier(modelEnvironmentType)) {
      target.effortLevel = runtimeModel === modelEnvironmentType
        ? DEFAULT_EFFORT_LEVEL[modelEnvironmentType] ?? DEFAULT_REASONING_VALUE
        : normalizeEffortLevel(runtimeModel, target.effortLevel);
      updateClaudeProviderSettings(target, {
        lastModel: modelEnvironmentType,
        modelEnvironmentType,
      });
    } else {
      target.lastCustomModel = model;
      target.effortLevel = normalizeEffortLevel(runtimeModel, target.effortLevel);
      updateClaudeProviderSettings(target, {
        modelEnvironmentType: modelEnvironmentType ?? '',
      });
    }
  },

  applyModelProjectionDefaults(model: string, settings: unknown): void {
    const target = settings as Record<string, unknown>;
    const runtimeModel = normalizeLegacyClaudeModelAlias(toClaudeRuntimeModelId(model));
    // Projection is read-only display of the live effort. Preserve the user's
    // selection (clamped to what the model supports) instead of resetting it to
    // the tier default, which previously discarded effort changes for every
    // default tier model except environment-mapped ones like Fable.
    target.effortLevel = normalizeEffortLevel(runtimeModel, target.effortLevel);
  },

  applyTitleGenerationModelSelection(model: string, settings: unknown): void {
    const target = settings as Record<string, unknown>;
    const claudeSettings = getClaudeProviderSettings(target);
    const environmentType = model
      ? resolveClaudeModelEnvironmentTypePreference(
        getClaudeModelOptions(target),
        model,
        claudeSettings.titleModelEnvironmentType,
      )
      : null;
    updateClaudeProviderSettings(target, {
      titleModelEnvironmentType: environmentType ?? '',
    });
  },

  normalizeModelVariant(model: string, settings) {
    const normalizedRuntimeModel = normalizeLegacyClaudeModelAlias(toClaudeRuntimeModelId(model));
    const option = findClaudeModelOption(getClaudeModelOptions(settings), model);
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
