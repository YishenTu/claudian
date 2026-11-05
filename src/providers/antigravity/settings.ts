import { selectModelMetadata } from '../../core/providers/models/selectedModelMetadata';
import { getProviderConfig, getProviderSelectionInputs, setProviderConfig } from '../../core/providers/providerConfig';
import {
  type AntigravityProviderSettings,
  decodeAntigravityConfig,
  getAntigravityMigratedVisibleModelIds,
  updateAntigravityConfig,
} from './config';

export const ANTIGRAVITY_PROVIDER_ID = 'antigravity' as const;

/** Reads Antigravity's configuration from the settings document. */
export function getAntigravityProviderSettings(settings: Record<string, unknown>): AntigravityProviderSettings {
  return decodeAntigravityConfig(
    getProviderConfig(settings, ANTIGRAVITY_PROVIDER_ID),
    getProviderSelectionInputs(settings, ANTIGRAVITY_PROVIDER_ID),
  );
}

/** Writes Antigravity's configuration into the settings document. */
export function updateAntigravityProviderSettings(
  settings: Record<string, unknown>,
  updates: Partial<AntigravityProviderSettings>,
): AntigravityProviderSettings {
  const config = getProviderConfig(settings, ANTIGRAVITY_PROVIDER_ID);
  const next = updateAntigravityConfig(config, getProviderSelectionInputs(settings, ANTIGRAVITY_PROVIDER_ID), updates);
  setProviderConfig(settings, ANTIGRAVITY_PROVIDER_ID, config);
  return next;
}

/** Durable projection: only selected models persist; full discovery catalogs stay runtime-only. */
export function projectAntigravityModelSettings(settings: Record<string, unknown>): Record<string, unknown> {
  const current = getAntigravityProviderSettings(settings);
  const visibleModels = getAntigravityMigratedVisibleModelIds(current);
  const selected = new Set(visibleModels);
  const selectedModelsByHost = Object.fromEntries(Object.entries(current.catalogsByHost).map(([host, catalog]) => [host, {
    ...catalog,
    defaultModelId: catalog.defaultModelId && selected.has(catalog.defaultModelId) ? catalog.defaultModelId : null,
    models: catalog.models.filter(model => selected.has(model.rawId)),
  }]));
  const config: Record<string, unknown> = {
    ...getProviderConfig(settings, ANTIGRAVITY_PROVIDER_ID),
    modelAliases: selectModelMetadata(current.modelAliases, selected),
    preferredReasoningByModel: selectModelMetadata(current.preferredReasoningByModel, selected),
    selectedModelsByHost,
    visibleModels,
  };
  delete config.catalogsByHost;
  delete config.currentCatalog;
  return config;
}
