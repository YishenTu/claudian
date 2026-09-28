import { getProviderConfig } from '../../core/providers/providerConfig';
import { getRuntimeEnvironmentVariables } from '../../core/providers/providerEnvironment';
import type { ProviderUIOption } from '../../core/providers/types';
import { getCustomModelIds } from './env/claudeModelEnv';
import { encodeClaudeModelSelectionId, toClaudeRuntimeModelId } from './modelSelection';
import { type ClaudeModelTier, isClaudeModelTier } from './modelTiers';
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

/** Exact identities win; a missing family member resolves to its highest reported version. */
export function findClaudeModelOption(
  options: readonly ClaudeModelOption[], model: string,
): ClaudeModelOption | undefined {
  const runtimeModel = toClaudeRuntimeModelId(model);
  const exact = options.find(option => option.value === model || toClaudeRuntimeModelId(option.value) === runtimeModel);
  if (exact) return exact;
  const resolved = options.filter(option => option.resolvedModel === runtimeModel);
  if (resolved.length) return resolved.length === 1 ? resolved[0] : undefined;
  return findClaudeFamilySuccessor(options, runtimeModel);
}

export function getClaudeModelOptions(settings: Record<string, unknown>): ClaudeModelOption[] {
  const catalog = getClaudeModelCatalog(settings);
  const selected = getClaudeVisibleModelIds(settings);
  return [...new Set(selected.flatMap(id => {
    const option = findClaudeModelOption(catalog, id);
    return option ? [option] : [];
  }))];
}

/** Whether the SDK reports the model as a value or a resolved identity, as opposed to a family successor. */
export function hasClaudeModelIdentity(options: readonly ClaudeModelOption[], model: string): boolean {
  const runtimeModel = toClaudeRuntimeModelId(model);
  return options.some(option => toClaudeRuntimeModelId(option.value) === runtimeModel
    || option.resolvedModel === runtimeModel);
}

/** Identities the catalog reports keep their meaning; anything else may only follow enabled models. */
export function findClaudeModelSelectionOption(
  settings: Record<string, unknown>, model: string,
): ClaudeModelOption | undefined {
  const catalog = getClaudeModelCatalog(settings);
  return findClaudeModelOption(hasClaudeModelIdentity(catalog, model) ? catalog : getClaudeModelOptions(settings), model);
}

/** The enabled option a saved selection runs as; undefined when its identity is unselected or unknown. */
export function findEnabledClaudeModelOption(
  settings: Record<string, unknown>, model: string,
): ClaudeModelOption | undefined {
  const selected = findClaudeModelSelectionOption(settings, model);
  return selected && getClaudeModelOptions(settings).some(option => option.value === selected.value)
    ? selected
    : undefined;
}

/** Effort levels Claude Code reported for the model; empty when unknown. */
export function getClaudeSupportedEffortLevels(
  settings: Record<string, unknown>,
  model: string,
): EffortLevel[] {
  return findClaudeModelSelectionOption(settings, model)?.supportedEffortLevels ?? [];
}

function isSelectableClaudeModel(model: string): boolean {
  return toClaudeRuntimeModelId(model) !== 'default';
}

interface ClaudeFamilyId {
  tier: ClaudeModelTier;
  /** Dashed numeric components without the trailing YYYYMMDD snapshot; empty for bare aliases. */
  version: string;
  oneMillion: boolean;
}

/** Reads `<tier>`, `claude-<tier>-<version>[-<snapshot>]`, and their `[1m]` variants. */
function parseClaudeFamilyId(id: string): ClaudeFamilyId | undefined {
  const oneMillion = id.endsWith('[1m]');
  const base = oneMillion ? id.slice(0, -'[1m]'.length) : id;
  if (isClaudeModelTier(base)) return { tier: base, version: '', oneMillion };
  const match = /^claude-([a-z]+)-(\d+(?:-\d+)*)?/.exec(base);
  if (!match || !isClaudeModelTier(match[1])) return undefined;
  return { tier: match[1], version: (match[2] ?? '').replace(/-\d{8}$/, ''), oneMillion };
}

/** A `[1m]` request accepts only `[1m]` rows; other requests prefer standard context on version ties. */
function findClaudeFamilySuccessor(
  options: readonly ClaudeModelOption[], runtimeModel: string,
): ClaudeModelOption | undefined {
  const wanted = parseClaudeFamilyId(runtimeModel);
  if (!wanted) return undefined;
  let best: { option: ClaudeModelOption; version: string; oneMillion: boolean } | undefined;
  for (const option of options) {
    if (!isSelectableClaudeModel(option.value)) continue;
    const ids = [option.resolvedModel, toClaudeRuntimeModelId(option.value)]
      .flatMap(id => id === undefined ? [] : [parseClaudeFamilyId(id)])
      .filter((id): id is ClaudeFamilyId => id?.tier === wanted.tier);
    const oneMillion = ids.some(id => id.oneMillion);
    if (!ids.length || (wanted.oneMillion && !oneMillion)) continue;
    const version = ids.find(id => id.version)?.version ?? '';
    const order = best ? version.localeCompare(best.version, 'en', { numeric: true }) : 1;
    if (order > 0 || (order === 0 && best?.oneMillion && !oneMillion)) best = { option, version, oneMillion };
  }
  return best?.option;
}
