import { getProviderConfig } from '../../core/providers/providerConfig';
import { getRuntimeEnvironmentVariables } from '../../core/providers/providerEnvironment';
import type { ProviderUIOption } from '../../core/providers/types';
import { getCustomModelIds } from './env/claudeModelEnv';
import { encodeClaudeModelSelectionId, toClaudeRuntimeModelId } from './modelSelection';
import { isClaudeModelTier } from './modelTiers';
import { getClaudeProviderSettings } from './settings';
import { DEFAULT_CLAUDE_MODELS, type EffortLevel } from './types/models';

export interface ClaudeModelOption extends ProviderUIOption {
  resolvedModel?: string;
  supportedEffortLevels?: EffortLevel[];
  reasoningMetadataResolved?: boolean;
}

export function getClaudeModelCatalog(settings: Record<string, unknown>): ClaudeModelOption[] {
  const aliases = getClaudeProviderSettings(settings).modelAliases;
  return getClaudeProviderSettings(settings).discoveredModels.filter(model => isSelectableClaudeModel(model.value)).map(model => ({
    ...model,
    value: isClaudeModelTier(model.value) ? model.value : encodeClaudeModelSelectionId(model.value),
    label: aliases?.[model.value] || model.label,
  }));
}

/** Legacy configuration only seeds enablement; it never creates catalog entries. */
export function getClaudeVisibleModelIds(settings: Record<string, unknown>): string[] {
  const config = getClaudeProviderSettings(settings);
  if (config.visibleModels !== null) return config.visibleModels.filter(isSelectableClaudeModel);
  const environmentIds = [...getCustomModelIds(getRuntimeEnvironmentVariables(settings, 'claude'))];
  const oldManualModels = getProviderConfig(settings, 'claude').customModels;
  return [...new Set([
    ...(environmentIds.length ? environmentIds : DEFAULT_CLAUDE_MODELS.map(model => model.value)),
    ...(typeof oldManualModels === 'string' ? oldManualModels.split(/\r?\n/).map(id => id.trim()).filter(Boolean) : []),
  ])].filter(isSelectableClaudeModel);
}

/** Match exact SDK identities first. A resolved ID is usable only when unambiguous. */
export function findClaudeModelOption(
  options: readonly ClaudeModelOption[], model: string,
): ClaudeModelOption | undefined {
  const runtimeModel = toClaudeRuntimeModelId(model);
  const exact = options.find(option => option.value === model || toClaudeRuntimeModelId(option.value) === runtimeModel);
  if (exact) return exact;
  const resolved = options.filter(option => option.resolvedModel === runtimeModel);
  return resolved.length === 1 ? resolved[0] : undefined;
}

export function getClaudeModelOptions(settings: Record<string, unknown>): ClaudeModelOption[] {
  const catalog = getClaudeModelCatalog(settings);
  const selected = getClaudeVisibleModelIds(settings);
  return [...new Set(selected.flatMap(id => {
    const option = findClaudeModelOption(catalog, id);
    return option ? [option] : [];
  }))];
}

/** Effort levels Claude Code reported for the model; empty when unknown. */
export function getClaudeSupportedEffortLevels(
  settings: Record<string, unknown>,
  model: string,
): EffortLevel[] {
  return findClaudeModelOption(getClaudeModelCatalog(settings), model)?.supportedEffortLevels ?? [];
}

function isSelectableClaudeModel(model: string): boolean {
  return toClaudeRuntimeModelId(model) !== 'default';
}
