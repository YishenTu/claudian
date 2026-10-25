import { selectModelMetadata } from '../../core/providers/models/selectedModelMetadata';
import { getProviderConfig, getProviderSelectionInputs, setProviderConfig } from '../../core/providers/providerConfig';
import {
  decodeGrokConfig,
  getGrokMigratedVisibleModelIds,
  type GrokCatalogSnapshot,
  type GrokProviderSettings,
  type PersistedGrokProviderSettings,
  updateCurrentGrokCatalogConfig,
  updateGrokConfig,
} from './config';

export {
  DEFAULT_GROK_PROVIDER_SETTINGS,
  getGrokMigratedVisibleModelIds,
  getOrderedGrokVisibleModelIds,
  type GrokCatalogSnapshot,
  type GrokProviderSettings,
  normalizeGrokCatalogSnapshot,
  normalizeGrokModelAliases,
  normalizeGrokPreferredReasoningByModel,
  normalizeGrokVisibleModels,
  type PersistedGrokProviderSettings,
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
  updates: Partial<PersistedGrokProviderSettings>,
): GrokProviderSettings {
  const config = getProviderConfig(settings, 'grok');
  const next = updateGrokConfig(config, getProviderSelectionInputs(settings, 'grok'), updates);
  setProviderConfig(settings, 'grok', config);
  return next;
}

export function getCurrentGrokCatalog(
  settings: Record<string, unknown>,
): GrokCatalogSnapshot | null {
  return getGrokProviderSettings(settings).currentCatalog;
}

export function updateCurrentGrokCatalog(
  settings: Record<string, unknown>,
  snapshot: GrokCatalogSnapshot,
): GrokCatalogSnapshot | null {
  const config = getProviderConfig(settings, 'grok');
  const normalized = updateCurrentGrokCatalogConfig(config, getProviderSelectionInputs(settings, 'grok'), snapshot);
  if (normalized) setProviderConfig(settings, 'grok', config);
  return normalized;
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
