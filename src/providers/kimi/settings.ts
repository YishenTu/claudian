import { getProviderConfig, setProviderConfig } from '../../core/providers/providerConfig';
import { getProviderEnvironmentVariables } from '../../core/providers/providerEnvironment';
import type { HostnameCliPaths } from '../../core/types/settings';
import {
  getHostnameKey,
  getLegacyHostnameKey,
  migrateLegacyHostnameKeyedMap,
} from '../../utils/env';
import {
  normalizeKimiModelKeyedStrings,
  normalizeKimiThinkingOptionsByModel,
  seedKimiDiscoveryStateFromConfig,
  updateKimiDiscoveryState,
} from './discoveryState';
import {
  type KimiDiscoveredModel,
  type KimiThinkingOption,
  normalizeKimiDiscoveredModels,
} from './models';

export interface KimiProviderConfig {
  cliPath: string;
  cliPathsByHost: HostnameCliPaths;
  currentThinkingByModel: Record<string, string>;
  discoveredModels: KimiDiscoveredModel[];
  enabled: boolean;
  environmentHash: string;
  environmentVariables: string;
  modelAliases: Record<string, string>;
  preferredThinkingByModel: Record<string, string>;
  thinkingOptionsByModel: Record<string, KimiThinkingOption[]>;
  visibleModels: string[] | null;
}

export const DEFAULT_KIMI_PROVIDER_CONFIG: Readonly<KimiProviderConfig> = Object.freeze({
  cliPath: '',
  cliPathsByHost: {},
  currentThinkingByModel: {},
  discoveredModels: [],
  enabled: false,
  environmentHash: '',
  environmentVariables: '',
  modelAliases: {},
  preferredThinkingByModel: {},
  thinkingOptionsByModel: {},
  visibleModels: null,
});

function normalizeHostnameCliPaths(value: unknown): HostnameCliPaths {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }

  const normalized: HostnameCliPaths = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === 'string' && entry.trim()) {
      normalized[key] = entry.trim();
    }
  }
  return normalized;
}

function normalizeKimiVisibleModels(value: unknown): string[] | null {
  if (!Array.isArray(value)) {
    return null;
  }

  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== 'string') {
      continue;
    }
    const trimmed = entry.trim();
    if (!trimmed || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    normalized.push(trimmed);
  }
  return normalized;
}

function readTrimmedString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function normalizeKimiStoredConfig(
  config: Record<string, unknown>,
): KimiProviderConfig {
  return {
    cliPath: readTrimmedString(config.cliPath) || DEFAULT_KIMI_PROVIDER_CONFIG.cliPath,
    cliPathsByHost: normalizeHostnameCliPaths(config.cliPathsByHost),
    currentThinkingByModel: normalizeKimiModelKeyedStrings(config.currentThinkingByModel),
    discoveredModels: normalizeKimiDiscoveredModels(config.discoveredModels),
    enabled: typeof config.enabled === 'boolean'
      ? config.enabled
      : DEFAULT_KIMI_PROVIDER_CONFIG.enabled,
    environmentHash: readTrimmedString(config.environmentHash),
    environmentVariables: typeof config.environmentVariables === 'string'
      ? config.environmentVariables
      : DEFAULT_KIMI_PROVIDER_CONFIG.environmentVariables,
    modelAliases: normalizeKimiModelKeyedStrings(config.modelAliases),
    preferredThinkingByModel: normalizeKimiModelKeyedStrings(config.preferredThinkingByModel),
    thinkingOptionsByModel: normalizeKimiThinkingOptionsByModel(config.thinkingOptionsByModel),
    visibleModels: normalizeKimiVisibleModels(config.visibleModels),
  };
}

export function getKimiProviderSettings(
  settings: Record<string, unknown>,
): KimiProviderConfig {
  const config = getProviderConfig(settings, 'kimi');
  const normalized = normalizeKimiStoredConfig(config);
  const cliPathsByHost = Object.keys(normalized.cliPathsByHost).length > 0
    ? migrateLegacyHostnameKeyedMap(
      normalized.cliPathsByHost,
      getHostnameKey(),
      getLegacyHostnameKey(),
    )
    : normalized.cliPathsByHost;
  seedKimiDiscoveryStateFromConfig(settings, config);

  return {
    ...normalized,
    cliPathsByHost,
    environmentVariables: typeof config.environmentVariables === 'string'
      ? config.environmentVariables
      : getProviderEnvironmentVariables(settings, 'kimi')
        ?? DEFAULT_KIMI_PROVIDER_CONFIG.environmentVariables,
  };
}

export function updateKimiProviderSettings(
  settings: Record<string, unknown>,
  updates: Partial<KimiProviderConfig>,
): KimiProviderConfig {
  const current = getKimiProviderSettings(settings);
  const hostnameKey = getHostnameKey();
  const cliPathsByHost = updates.cliPathsByHost !== undefined
    ? normalizeHostnameCliPaths(updates.cliPathsByHost)
    : { ...current.cliPathsByHost };
  let cliPath = updates.cliPathsByHost !== undefined
    ? readTrimmedString(updates.cliPath)
    : current.cliPath;

  if ('cliPath' in updates && updates.cliPathsByHost === undefined) {
    const hostCliPath = readTrimmedString(updates.cliPath);
    if (hostCliPath) {
      cliPathsByHost[hostnameKey] = hostCliPath;
    } else {
      delete cliPathsByHost[hostnameKey];
    }
    cliPath = DEFAULT_KIMI_PROVIDER_CONFIG.cliPath;
  }

  if (updates.discoveredModels !== undefined) {
    updateKimiDiscoveryState(settings, { discoveredModels: updates.discoveredModels });
  }
  if (updates.thinkingOptionsByModel !== undefined) {
    updateKimiDiscoveryState(settings, { thinkingOptionsByModel: updates.thinkingOptionsByModel });
  }
  if (updates.currentThinkingByModel !== undefined) {
    updateKimiDiscoveryState(settings, { currentThinkingByModel: updates.currentThinkingByModel });
  }

  const next: KimiProviderConfig = {
    cliPath,
    cliPathsByHost,
    currentThinkingByModel: updates.currentThinkingByModel !== undefined
      ? normalizeKimiModelKeyedStrings(updates.currentThinkingByModel)
      : current.currentThinkingByModel,
    discoveredModels: updates.discoveredModels !== undefined
      ? normalizeKimiDiscoveredModels(updates.discoveredModels)
      : current.discoveredModels,
    enabled: updates.enabled ?? current.enabled,
    environmentHash: updates.environmentHash !== undefined
      ? readTrimmedString(updates.environmentHash)
      : current.environmentHash,
    environmentVariables: updates.environmentVariables ?? current.environmentVariables,
    modelAliases: updates.modelAliases !== undefined
      ? normalizeKimiModelKeyedStrings(updates.modelAliases)
      : current.modelAliases,
    preferredThinkingByModel: updates.preferredThinkingByModel !== undefined
      ? normalizeKimiModelKeyedStrings(updates.preferredThinkingByModel)
      : current.preferredThinkingByModel,
    thinkingOptionsByModel: updates.thinkingOptionsByModel !== undefined
      ? normalizeKimiThinkingOptionsByModel(updates.thinkingOptionsByModel)
      : current.thinkingOptionsByModel,
    visibleModels: updates.visibleModels !== undefined
      ? normalizeKimiVisibleModels(updates.visibleModels)
      : current.visibleModels,
  };

  setProviderConfig(settings, 'kimi', next as unknown as Record<string, unknown>);
  return next;
}
