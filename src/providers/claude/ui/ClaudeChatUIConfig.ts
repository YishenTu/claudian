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
  getClaudeModelCatalog,
  getClaudeModelOptions,
  getClaudeVisibleModelIds,
} from '../modelOptions';
import { isClaudeModelSelectionId, toClaudeRuntimeModelId } from '../modelSelection';
import { isClaudeModelTier } from '../modelTiers';
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
};

export const claudeChatUIConfig: ProviderChatUIConfig = {
  preserveUnavailableModelSelection: true,
  getModelOptions(settings) {
    // The chat dropdown renders options in reverse order, as for other providers.
    return getClaudeModelOptions(settings).reverse();
  },

  getDefaultModel(settings) {
    return getClaudeModelOptions(settings)[0]?.value ?? null;
  },

  ownsModel(model: string, settings: Record<string, unknown>): boolean {
    const runtimeModel = toClaudeRuntimeModelId(model);
    return isClaudeModelSelectionId(model) || isClaudeModelTier(normalizeLegacyClaudeModelAlias(model))
      || getClaudeVisibleModelIds(settings).some(id => toClaudeRuntimeModelId(id) === runtimeModel)
      || Boolean(findClaudeModelOption(getClaudeModelCatalog(settings), model));
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

    const modelId = toClaudeRuntimeModelId(model);
    const runtimeModel = normalizeLegacyClaudeModelAlias(modelId);
    target.effortLevel = isClaudeModelTier(modelId)
      ? DEFAULT_EFFORT_LEVEL[modelId] ?? DEFAULT_REASONING_VALUE
      : normalizeEffortLevel(runtimeModel, target.effortLevel);
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

  normalizeModelVariant(model: string, settings) {
    return findClaudeModelOption(getClaudeModelCatalog(settings), model)?.value ?? model;
  },

  normalizeAvailableModelSelection(model: string, settings) {
    return findClaudeModelOption(getClaudeModelCatalog(settings), model)?.value ?? model;
  },

  getCustomModelIds(envVars: Record<string, string>): Set<string> {
    return getCustomModelIds(envVars);
  },

  getPermissionModeToggle() {
    return CLAUDE_PERMISSION_MODE_TOGGLE;
  },

  getProviderIcon() {
    return CLAUDE_PROVIDER_ICON;
  },
};

/** Re-export for type-only use in provider registration. */
export type { ProviderUIOption };
