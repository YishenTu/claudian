import { selectModelMetadata } from '../../core/providers/models/selectedModelMetadata';
import { decodeClaudeConfig } from './config';
import { type ClaudeModelSource, resolveClaudeVisibleModels } from './modelOptions';
import { toClaudeRuntimeModelId } from './modelSelection';

/** The stored configuration persisted for Claude: only selected models and their aliases. */
export function projectClaudeModelConfig(source: ClaudeModelSource): Record<string, unknown> {
  const stored = source.config;
  const current = decodeClaudeConfig(stored);
  const resolved = resolveClaudeVisibleModels(source);
  const visibleModels = resolved.map(({ id }) => id);
  const selected = new Set(resolved.flatMap(({ id, option }) => option ? [id, toClaudeRuntimeModelId(option.value)] : [id]));
  const selectedModels = current.discoveredModels.filter(model => selected.has(model.value)
    || (model.resolvedModel !== undefined && selected.has(model.resolvedModel)));
  const aliasIds = new Set([...visibleModels, ...selectedModels.map(model => model.value)]);
  const config = {
    ...stored,
    visibleModels,
    selectedModels,
    modelAliases: selectModelMetadata(current.modelAliases, aliasIds),
  };
  for (const key of ['discoveredModels', 'catalogTimestamp', 'catalogFingerprint', 'availableModes']) delete (config as Record<string, unknown>)[key];
  return config;
}
