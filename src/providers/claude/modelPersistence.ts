import { selectModelMetadata } from '../../core/providers/models/selectedModelMetadata';
import { getProviderConfig } from '../../core/providers/providerConfig';
import { resolveClaudeVisibleModels } from './modelOptions';
import { toClaudeRuntimeModelId } from './modelSelection';
import { getClaudeProviderSettings } from './settings';

export function projectClaudeModelSettings(settings: Record<string, unknown>): Record<string, unknown> {
  const current = getClaudeProviderSettings(settings);
  const resolved = resolveClaudeVisibleModels(settings);
  const visibleModels = resolved.map(({ id }) => id);
  const selected = new Set(resolved.flatMap(({ id, option }) => option ? [id, toClaudeRuntimeModelId(option.value)] : [id]));
  const selectedModels = current.discoveredModels.filter(model => selected.has(model.value)
    || (model.resolvedModel !== undefined && selected.has(model.resolvedModel)));
  const aliasIds = new Set([...visibleModels, ...selectedModels.map(model => model.value)]);
  const config = {
    ...getProviderConfig(settings, 'claude'),
    visibleModels,
    selectedModels,
    modelAliases: selectModelMetadata(current.modelAliases, aliasIds),
  };
  for (const key of ['discoveredModels', 'catalogTimestamp', 'catalogFingerprint', 'availableModes']) delete (config as Record<string, unknown>)[key];
  return config;
}
