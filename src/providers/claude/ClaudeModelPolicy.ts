import { formatReasoningValueLabel } from '../../core/providers/reasoning';
import type {
  ProviderModelPolicy,
  ProviderReasoningOption,
} from '../../core/providers/types';
import { getCustomModelIds } from './env/claudeModelEnv';
import {
  findClaudeModelOption,
  findClaudeModelSelectionOption,
  getClaudeModelCatalog,
  getClaudeModelOptions,
  getClaudeSupportedEffortLevels,
  getClaudeVisibleModelIds,
} from './modelOptions';
import { isClaudeModelSelectionId, toClaudeRuntimeModelId } from './modelSelection';
import { CLAUDE_MODEL_TIER_PATTERN, isClaudeModelTier } from './modelTiers';
import { CLAUDE_PERMISSION_MODE_POLICY } from './permissionModes';
import { getClaudeProviderSettings, updateClaudeProviderSettings } from './settings';
import {
  isDefaultClaudeModel,
  resolveSupportedEffortLevel
} from './types/models';

const VERSIONED_CLAUDE_MODEL = new RegExp(`^claude-(?:${CLAUDE_MODEL_TIER_PATTERN})-`);

export const claudeModelPolicy: ProviderModelPolicy = {
  permissionModes: CLAUDE_PERMISSION_MODE_POLICY,
  customModelAliases: {
    get: settings => getClaudeProviderSettings(settings).modelAliases,
    update: (settings, modelAliases) => { updateClaudeProviderSettings(settings, { modelAliases }); },
  },
  getModelOptions(settings) {
    return getClaudeModelOptions(settings);
  },

  getDefaultModel(settings) {
    return getClaudeModelOptions(settings)[0]?.value ?? null;
  },

  ownsModel(model: string, settings: Record<string, unknown>): boolean {
    const runtimeModel = toClaudeRuntimeModelId(model);
    return VERSIONED_CLAUDE_MODEL.test(model) || isClaudeModelSelectionId(model) || isClaudeModelTier(runtimeModel)
      || getClaudeVisibleModelIds(settings).some(id => toClaudeRuntimeModelId(id) === runtimeModel)
      || Boolean(findClaudeModelOption(getClaudeModelCatalog(settings), model));
  },

  // Claude reasoning is effort-only: every model reads `effortLevel`, never a thinking budget.
  // ModelInfo.supportsAdaptiveThinking describes the native thinking mode, not this setting choice.
  isAdaptiveReasoningModel(_model: string, _settings: Record<string, unknown>): boolean {
    return true;
  },

  getReasoningOptions(model: string, settings: Record<string, unknown>): ProviderReasoningOption[] {
    return getClaudeSupportedEffortLevels(settings, model)
      .map(value => ({ value, label: formatReasoningValueLabel(value) }));
  },

  getDefaultReasoningValue(model: string, settings: Record<string, unknown>): string {
    return resolveClaudeEffortSetting(model, settings);
  },

  isDefaultModel(model: string): boolean {
    return isDefaultClaudeModel(model);
  },

  applyModelDefaults: applyClaudeEffortSetting,

  applyModelProjectionDefaults: applyClaudeEffortSetting,

  normalizeModelVariant: normalizeClaudeModelSelection,

  // Claude's variant normalization applies no fallback policy: a reported identity keeps its meaning,
  // anything else may only follow an enabled model, and an unresolved model is returned unchanged.
  // Availability canonicalization is therefore the same operation.
  normalizeAvailableModelSelection: normalizeClaudeModelSelection,

  getCustomModelIds(envVars: Record<string, string>): Set<string> {
    return getCustomModelIds(envVars);
  }
};

function normalizeClaudeModelSelection(model: string, settings: Record<string, unknown>): string {
  return findClaudeModelSelectionOption(settings, model)?.value ?? model;
}

function applyClaudeEffortSetting(model: string, settings: unknown): void {
  const target = settings as Record<string, unknown>;
  target.effortLevel = resolveClaudeEffortSetting(model, target);
}

/**
 * Normalizes the saved effort preference against reported capabilities. While
 * the model has no reported levels, the preference is kept for later use.
 */
function resolveClaudeEffortSetting(model: string, settings: Record<string, unknown>): string {
  const saved = typeof settings.effortLevel === 'string' ? settings.effortLevel : '';
  return resolveSupportedEffortLevel(getClaudeSupportedEffortLevels(settings, model), saved) ?? saved;
}
