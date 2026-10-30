import { selectModelMetadata } from '../../core/providers/models/selectedModelMetadata';
import { getProviderConfig, getProviderSelectionInputs, setProviderConfig } from '../../core/providers/providerConfig';
import {
  decodeGrokConfig,
  getGrokMigratedVisibleModelIds,
  type GrokProviderSettings,
  updateGrokConfig,
} from './config';

/** Reads Grok's configuration from the settings document. */
export function getGrokProviderSettings(
  settings: Record<string, unknown>,
): GrokProviderSettings {
  return decodeGrokConfig(getProviderConfig(settings, 'grok'), getProviderSelectionInputs(settings, 'grok'));
}

/** Writes Grok's configuration into the settings document. */
export function updateGrokProviderSettings(
  settings: Record<string, unknown>,
  updates: Partial<GrokProviderSettings>,
): GrokProviderSettings {
  const config = getProviderConfig(settings, 'grok');
  const next = updateGrokConfig(config, getProviderSelectionInputs(settings, 'grok'), updates);
  setProviderConfig(settings, 'grok', config);
  return next;
}

export function projectGrokModelSettings(settings: Record<string, unknown>): Record<string, unknown> {
  const current = getGrokProviderSettings(settings);
  const visibleModels = getGrokMigratedVisibleModelIds(current);
  const selected = new Set(visibleModels);
  const selectedModelsByHost = Object.fromEntries(Object.entries(current.catalogsByHost).map(([host, catalog]) => [host, {
    ...catalog,
    models: catalog.models.filter(model => selected.has(model.rawId)),
    defaultModelId: catalog.defaultModelId && selected.has(catalog.defaultModelId) ? catalog.defaultModelId : null,
  }]));
  const config: Record<string, unknown> = {
    ...getProviderConfig(settings, 'grok'),
    visibleModels,
    selectedModelsByHost,
    modelAliases: selectModelMetadata(current.modelAliases, selected),
    preferredReasoningByModel: selectModelMetadata(current.preferredReasoningByModel, selected),
  };
  delete config.catalogsByHost;
  delete config.currentCatalog;
  return config;
}
