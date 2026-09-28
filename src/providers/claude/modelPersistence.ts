import { selectModelMetadata } from '../../core/providers/models/selectedModelMetadata';
import { getProviderConfig } from '../../core/providers/providerConfig';
import { findClaudeModelOption, getClaudeVisibleModelIds } from './modelOptions';
import { getClaudeProviderSettings } from './settings';

export function projectClaudeModelSettings(settings: Record<string, unknown>): Record<string, unknown> {
  const current = getClaudeProviderSettings(settings);
  const visibleModels = getClaudeVisibleModelIds(settings);
  const selected = new Set(visibleModels);
  for (const id of visibleModels) {
    const model = findClaudeModelOption(current.discoveredModels, id);
    if (model) selected.add(model.value);
  }
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
