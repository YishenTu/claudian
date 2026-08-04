import { getProviderConfig, setProviderConfig } from '../../core/providers/providerConfig';
import { getProviderEnvironmentVariables } from '../../core/providers/providerEnvironment';
import { normalizeHostnameStringMap } from '../../core/providers/settings/HostnameStringMap';
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
  visibleModels: [],
});

export function getOmpProviderSettings(settings: Record<string, unknown>): OmpProviderSettings {
  const config = getProviderConfig(settings, 'omp');
  const discoveredModels = normalizeOmpDiscoveredModels(config.discoveredModels);
  return {
    cliPath: typeof config.cliPath === 'string' ? config.cliPath : DEFAULT_OMP_PROVIDER_SETTINGS.cliPath,
    cliPathsByHost: normalizeHostnameStringMap(config.cliPathsByHost),
    enabled: config.enabled === true,
    environmentHash: typeof config.environmentHash === 'string' ? config.environmentHash : '',
    environmentVariables: typeof config.environmentVariables === 'string'
      ? config.environmentVariables
      : getProviderEnvironmentVariables(settings, 'omp') ?? '',
    thinking: normalizeOmpThinkingConfig(config.thinking),
    discoveredModels,
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
