import { formatReasoningValueLabel } from '../../../core/providers/reasoning';
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
  getClaudeSupportedEffortLevels,
  getClaudeVisibleModelIds,
} from '../modelOptions';
import { isClaudeModelSelectionId, toClaudeRuntimeModelId } from '../modelSelection';
import { isClaudeModelTier } from '../modelTiers';
import { getClaudeProviderSettings, updateClaudeProviderSettings } from '../settings';
import {
  isDefaultClaudeModel,
  resolveSupportedEffortLevel
} from '../types/models';

const CLAUDE_PERMISSION_MODE_TOGGLE: ProviderPermissionModeToggleConfig = {
  inactiveValue: 'normal',
  inactiveLabel: 'Safe',
  activeValue: 'yolo',
  activeLabel: 'YOLO',
};

export const claudeChatUIConfig: ProviderChatUIConfig = {
  customModelAliases: {
    get: settings => getClaudeProviderSettings(settings).modelAliases,
    update: (settings, modelAliases) => { updateClaudeProviderSettings(settings, { modelAliases }); },
  },
  getModelOptions(settings) {
    // The chat dropdown renders options in reverse order, as for other providers.
    return getClaudeModelOptions(settings).reverse();
  },

  getDefaultModel(settings) {
    return getClaudeModelOptions(settings)[0]?.value ?? null;
  },

  ownsModel(model: string, settings: Record<string, unknown>): boolean {
    const runtimeModel = toClaudeRuntimeModelId(model);
    return /^claude-(?:haiku|sonnet|opus)-/.test(model) || isClaudeModelSelectionId(model) || isClaudeModelTier(runtimeModel)
      || getClaudeVisibleModelIds(settings).some(id => toClaudeRuntimeModelId(id) === runtimeModel)
      || Boolean(findClaudeModelOption(getClaudeModelCatalog(settings), model));
  },

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

/** Re-export for type-only use in provider registration. */
export type { ProviderUIOption };
