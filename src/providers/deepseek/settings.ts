import { selectModelMetadata } from '@/core/providers/models/selectedModelMetadata';
import { getProviderConfig, setProviderConfig } from '@/core/providers/providerConfig';

import { decodeDeepSeekConfig, type DeepSeekProviderSettings, updateDeepSeekConfig } from './config';

export {
  type DeepSeekProviderSettings,
  DEFAULT_DEEPSEEK_PROVIDER_SETTINGS,
  findDeepSeekModel,
  isDeepSeekModelSelectable,
} from './config';

/** Reads DeepSeek's configuration from the settings document. */
export function getDeepSeekProviderSettings(settings: Record<string, unknown>): DeepSeekProviderSettings {
  return decodeDeepSeekConfig(getProviderConfig(settings, 'deepseek'));
}

/** Writes DeepSeek's configuration into the settings document. */
export function updateDeepSeekProviderSettings(
  settings: Record<string, unknown>, updates: Partial<DeepSeekProviderSettings>,
): DeepSeekProviderSettings {
  const config = getProviderConfig(settings, 'deepseek');
  const next = updateDeepSeekConfig(config, updates);
  setProviderConfig(settings, 'deepseek', config);
  return next;
}

export function projectDeepSeekModelSettings(settings: Record<string, unknown>): Record<string, unknown> {
  const current = getDeepSeekProviderSettings(settings);
  const selected = new Set(current.visibleModels);
  const config: Record<string, unknown> = {
    ...getProviderConfig(settings, 'deepseek'), ...current,
    selectedModels: current.discoveredModels.filter(model => selected.has(model.encodedId)),
    modelAliases: selectModelMetadata(current.modelAliases, selected),
    preferredReasoningByModel: selectModelMetadata(current.preferredReasoningByModel, selected),
  };
  delete config.discoveredModels;
  return config;
}
