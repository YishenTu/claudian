import { getProviderConfig, setProviderConfig } from '../../core/providers/providerConfig';
import { getProviderEnvironmentVariables } from '../../core/providers/providerEnvironment';
import { normalizeHostnameStringMap } from '../../core/providers/settings/HostnameStringMap';
import type { HostnameCliPaths } from '../../core/types/settings';
import {
  type CursorDiscoveredModel,
  normalizeCursorDiscoveredModels,
  normalizeCursorVisibleModels,
} from './models';

export interface CursorProviderSettings {
  cliPath: string;
  cliPathsByHost: HostnameCliPaths;
  enabled: boolean;
  environmentHash: string;
  environmentVariables: string;
  discoveredModels: CursorDiscoveredModel[];
  catalogTimestamp: number;
  visibleModels: string[];
}

export const DEFAULT_CURSOR_PROVIDER_SETTINGS: Readonly<CursorProviderSettings> = Object.freeze({
  cliPath: '',
  cliPathsByHost: {},
  enabled: false,
  environmentHash: '',
  environmentVariables: '',
  discoveredModels: [],
  catalogTimestamp: 0,
  visibleModels: [],
});

export function getCursorProviderSettings(settings: Record<string, unknown>): CursorProviderSettings {
  const config = getProviderConfig(settings, 'cursor');
  const discoveredModels = normalizeCursorDiscoveredModels(config.discoveredModels);
  return {
    cliPath: typeof config.cliPath === 'string' ? config.cliPath : DEFAULT_CURSOR_PROVIDER_SETTINGS.cliPath,
    cliPathsByHost: normalizeHostnameStringMap(config.cliPathsByHost),
    enabled: config.enabled === true,
    environmentHash: typeof config.environmentHash === 'string' ? config.environmentHash : '',
    environmentVariables: typeof config.environmentVariables === 'string'
      ? config.environmentVariables
      : getProviderEnvironmentVariables(settings, 'cursor') ?? '',
    discoveredModels,
    catalogTimestamp: typeof config.catalogTimestamp === 'number' ? config.catalogTimestamp : 0,
    visibleModels: normalizeCursorVisibleModels(config.visibleModels, discoveredModels),
  };
}

export function updateCursorProviderSettings(
  settings: Record<string, unknown>,
  updates: Partial<CursorProviderSettings>,
): CursorProviderSettings {
  const current = getCursorProviderSettings(settings);
  const discoveredModels = normalizeCursorDiscoveredModels(
    updates.discoveredModels ?? current.discoveredModels,
  );
  const next = {
    ...current,
    ...updates,
    discoveredModels,
    visibleModels: normalizeCursorVisibleModels(
      updates.visibleModels ?? current.visibleModels,
      discoveredModels,
    ),
  };
  setProviderConfig(settings, 'cursor', next);
  return next;
}
