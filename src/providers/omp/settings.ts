import { getProviderConfig, setProviderConfig } from '../../core/providers/providerConfig';
import { getProviderEnvironmentVariables } from '../../core/providers/providerEnvironment';
import { normalizeHostnameStringMap } from '../../core/providers/settings/HostnameStringMap';
import {
  readStoredBoolean,
  readStoredString,
} from '../../core/providers/settings/storedSettings';
import type { HostnameCliPaths } from '../../core/types/settings';
import {
  normalizeOmpDiscoveredModels,
  normalizeOmpThinkingConfig,
  normalizeOmpVisibleModels,
  type OmpDiscoveredModel,
  type OmpThinkingConfig,
} from './models';

export interface OmpProviderSettings {
  cliPath: string;
  cliPathsByHost: HostnameCliPaths;
  enabled: boolean;
  environmentHash: string;
  environmentVariables: string;
  thinking: OmpThinkingConfig | null;
  discoveredModels: OmpDiscoveredModel[];
  catalogTimestamp: number;
  visibleModels: string[];
}

export const DEFAULT_OMP_PROVIDER_SETTINGS: Readonly<OmpProviderSettings> = Object.freeze({
  cliPath: '',
  cliPathsByHost: {},
  enabled: false,
  environmentHash: '',
  environmentVariables: '',
  thinking: null,
  discoveredModels: [],
  catalogTimestamp: 0,
  visibleModels: [],
});

export function getOmpProviderSettings(settings: Record<string, unknown>): OmpProviderSettings {
  const config = getProviderConfig(settings, 'omp');
  const discoveredModels = normalizeOmpDiscoveredModels(config.discoveredModels);
  return {
    cliPath: readStoredString(config.cliPath, DEFAULT_OMP_PROVIDER_SETTINGS.cliPath),
    cliPathsByHost: normalizeHostnameStringMap(config.cliPathsByHost),
    enabled: readStoredBoolean(config.enabled, DEFAULT_OMP_PROVIDER_SETTINGS.enabled),
    environmentHash: readStoredString(
      config.environmentHash,
      DEFAULT_OMP_PROVIDER_SETTINGS.environmentHash,
    ),
    environmentVariables: readStoredString(
      config.environmentVariables,
      getProviderEnvironmentVariables(settings, 'omp')
        ?? DEFAULT_OMP_PROVIDER_SETTINGS.environmentVariables,
    ),
    thinking: normalizeOmpThinkingConfig(config.thinking),
    discoveredModels,
    catalogTimestamp: typeof config.catalogTimestamp === 'number'
      && Number.isFinite(config.catalogTimestamp)
      && config.catalogTimestamp >= 0
      ? Math.floor(config.catalogTimestamp)
      : DEFAULT_OMP_PROVIDER_SETTINGS.catalogTimestamp,
    visibleModels: normalizeOmpVisibleModels(config.visibleModels, discoveredModels),
  };
}

export function updateOmpProviderSettings(
  settings: Record<string, unknown>,
  updates: Partial<OmpProviderSettings>,
): OmpProviderSettings {
  const current = getOmpProviderSettings(settings);
  const discoveredModels = normalizeOmpDiscoveredModels(
    updates.discoveredModels ?? current.discoveredModels,
  );
  const next = {
    ...current,
    ...updates,
    discoveredModels,
    visibleModels: normalizeOmpVisibleModels(
      updates.visibleModels ?? current.visibleModels,
      discoveredModels,
    ),
  };
  setProviderConfig(settings, 'omp', next);
  return next;
}
