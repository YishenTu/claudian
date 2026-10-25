import { getProviderConfig } from '../../core/providers/providerConfig';
import { formatReasoningValueLabel } from '../../core/providers/reasoning';
import type {
  ProviderModelPolicy,
  ProviderPermissionModePolicy,
  ProviderUIOption,
} from '../../core/providers/types';
import { getCustomModelIds } from './claudeModelEnv';
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
import { CLAUDE_PERMISSION_MODES, type ClaudePermissionMode } from './permissionModes';
import { getClaudeModelSource, getClaudeProviderSettings, updateClaudeProviderSettings } from './settings';
import {
  isDefaultClaudeModel,
  resolveSupportedEffortLevel
} from './types/models';

const VERSIONED_CLAUDE_MODEL = new RegExp(`^claude-(?:${CLAUDE_MODEL_TIER_PATTERN})-`);

/** Retired Safe-toggle targets, stored as `providerConfigs.claude.safeMode`. */
const LEGACY_SAFE_MODES: Readonly<Record<string, ClaudePermissionMode>> = {
  auto: 'auto',
  default: 'manual',
  acceptEdits: 'acceptEdits',
};

const CLAUDE_PERMISSION_MODE_POLICY: ProviderPermissionModePolicy = Object.freeze({
  values: CLAUDE_PERMISSION_MODES,
  fallbackValue: 'manual',
  defaultValue: 'auto',
  migrateValue(value: string, settings: Record<string, unknown>): string | undefined {
    if (value !== 'normal') return undefined;
    // The retired Safe toggle ran the configured safe mode, which defaulted to acceptEdits.
    const safeMode = getProviderConfig(settings, 'claude').safeMode;
    return safeMode === undefined ? 'acceptEdits' : typeof safeMode === 'string' ? LEGACY_SAFE_MODES[safeMode] : undefined;
  },
});

export const claudeModelPolicy: ProviderModelPolicy = {
  permissionModes: CLAUDE_PERMISSION_MODE_POLICY,
  customModelAliases: {
    get: settings => getClaudeProviderSettings(settings).modelAliases,
    update: (settings, modelAliases) => { updateClaudeProviderSettings(settings, { modelAliases }); },
  },
  getModelOptions(settings) {
    return getClaudeModelOptions(getClaudeModelSource(settings));
  },

  getDefaultModel(settings) {
    return getClaudeModelOptions(getClaudeModelSource(settings))[0]?.value ?? null;
  },

  ownsModel(model: string, settings: Record<string, unknown>): boolean {
    const runtimeModel = toClaudeRuntimeModelId(model);
    const source = getClaudeModelSource(settings);
    return VERSIONED_CLAUDE_MODEL.test(model) || isClaudeModelSelectionId(model) || isClaudeModelTier(runtimeModel)
      || getClaudeVisibleModelIds(source).some(id => toClaudeRuntimeModelId(id) === runtimeModel)
      || Boolean(findClaudeModelOption(getClaudeModelCatalog(source), model));
  },

  // Claude reasoning is effort-only: every model reads `effortLevel`.
  // ModelInfo.supportsAdaptiveThinking describes the native thinking mode, not this setting choice.
  supportsReasoningEffort(_model: string, _settings: Record<string, unknown>): boolean {
    return true;
  },

  getReasoningOptions(model: string, settings: Record<string, unknown>): ProviderUIOption[] {
    return getClaudeSupportedEffortLevels(getClaudeModelSource(settings), model)
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
  return findClaudeModelSelectionOption(getClaudeModelSource(settings), model)?.value ?? model;
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
  return resolveSupportedEffortLevel(getClaudeSupportedEffortLevels(getClaudeModelSource(settings), model), saved) ?? saved;
}
