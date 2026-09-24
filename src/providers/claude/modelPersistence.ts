import { getProviderConfig } from '../../core/providers/providerConfig';
import { getClaudeVisibleModelIds } from './modelOptions';
import { getClaudeProviderSettings } from './settings';

export function projectClaudeModelSettings(settings: Record<string, unknown>): Record<string, unknown> {
  const current = getClaudeProviderSettings(settings);
  const visibleModels = getClaudeVisibleModelIds(settings);
  const selected = new Set(visibleModels);
  const config = { ...getProviderConfig(settings, 'claude'), modelAliases: current.modelAliases, visibleModels, selectedModels: current.discoveredModels.filter(model => selected.has(model.value) || (model.resolvedModel !== undefined && selected.has(model.resolvedModel))) };
  for (const key of ['discoveredModels', 'catalogTimestamp', 'catalogFingerprint', 'availableModes']) delete (config as Record<string, unknown>)[key];
  return config;
}
