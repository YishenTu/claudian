import { getProviderConfig, setProviderConfig } from '../../core/providers/providerConfig';
import { getProviderEnvironmentVariables } from '../../core/providers/providerEnvironment';
import type { HostnameCliPaths } from '../../core/types/settings';
import {
  getHostnameKey,
  getLegacyHostnameKey,
  migrateLegacyHostnameKeyedMap,
} from '../../utils/env';
import {
  type HermesDiscoveredModel,
  normalizeHermesDiscoveredModels,
  resolveHermesBaseModelRawId,
} from './models';

export interface PersistedHermesProviderSettings {
  cliPath: string;
  cliPathsByHost: HostnameCliPaths;
  discoveredModels: HermesDiscoveredModel[];
  enabled: boolean;
  environmentHash: string;
  environmentVariables: string;
  modelAliases: Record<string, string>;
  preferredThinkingByModel: Record<string, string>;
  profile: string;
  visibleModels: string[];
}

export const HERMES_DEFAULT_ENVIRONMENT_VARIABLES = '';

export const DEFAULT_HERMES_PROVIDER_SETTINGS: Readonly<PersistedHermesProviderSettings> = Object.freeze({
  cliPath: '',
  cliPathsByHost: {},
  discoveredModels: [],
  enabled: false,
  environmentHash: '',
  environmentVariables: HERMES_DEFAULT_ENVIRONMENT_VARIABLES,
  modelAliases: {},
  preferredThinkingByModel: {},
  profile: '',
  visibleModels: [],
});

function normalizeHostnameCliPaths(value: unknown): HostnameCliPaths {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }

  const result: HostnameCliPaths = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === 'string' && entry.trim()) {
      result[key] = entry.trim();
    }
  }
  return result;
}

export function normalizeHermesVisibleModels(
  value: unknown,
  discoveredModels: HermesDiscoveredModel[] = [],
): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== 'string') {
      continue;
    }

    const trimmed = resolveHermesBaseModelRawId(entry.trim());
    if (!trimmed || seen.has(trimmed)) {
      continue;
    }

    seen.add(trimmed);
    normalized.push(trimmed);
  }

  return normalized;
}

export function normalizeHermesModelAliases(
  value: unknown,
  discoveredModels: HermesDiscoveredModel[] = [],
): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }

  const normalized: Record<string, string> = {};
  for (const [rawId, alias] of Object.entries(value as Record<string, unknown>)) {
    if (typeof alias !== 'string') {
      continue;
    }

    const normalizedRawId = resolveHermesBaseModelRawId(rawId.trim());
    const normalizedAlias = alias.trim();
    if (!normalizedRawId || !normalizedAlias) {
      continue;
    }

    normalized[normalizedRawId] = normalizedAlias;
  }

  return normalized;
}

export function normalizeHermesPreferredThinkingByModel(
  value: unknown,
): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }

  const normalized: Record<string, string> = {};
  for (const [rawId, thinkingLevel] of Object.entries(value as Record<string, unknown>)) {
    if (typeof thinkingLevel !== 'string') {
      continue;
    }

    const normalizedRawId = resolveHermesBaseModelRawId(rawId.trim());
    const normalizedThinkingLevel = thinkingLevel.trim();
    if (!normalizedRawId || !normalizedThinkingLevel) {
      continue;
    }

    normalized[normalizedRawId] = normalizedThinkingLevel;
  }

  return normalized;
}

export function getHermesProviderSettings(
  settings: Record<string, unknown>,
): PersistedHermesProviderSettings {
  const config = getProviderConfig(settings, 'hermes');
  const normalizedCliPathsByHost = normalizeHostnameCliPaths(config.cliPathsByHost);
  const cliPathsByHost = Object.keys(normalizedCliPathsByHost).length > 0
    ? migrateLegacyHostnameKeyedMap(
      normalizedCliPathsByHost,
      getHostnameKey(),
      getLegacyHostnameKey(),
    )
    : normalizedCliPathsByHost;
  const discoveredModels = normalizeHermesDiscoveredModels(config.discoveredModels);

  return {
    cliPath: (config.cliPath as string | undefined)
      ?? DEFAULT_HERMES_PROVIDER_SETTINGS.cliPath,
    cliPathsByHost,
    discoveredModels,
    enabled: (config.enabled as boolean | undefined)
      ?? DEFAULT_HERMES_PROVIDER_SETTINGS.enabled,
    environmentHash: (config.environmentHash as string | undefined)
      ?? DEFAULT_HERMES_PROVIDER_SETTINGS.environmentHash,
    environmentVariables: (config.environmentVariables as string | undefined)
      ?? getProviderEnvironmentVariables(settings, 'hermes')
      ?? DEFAULT_HERMES_PROVIDER_SETTINGS.environmentVariables,
    modelAliases: normalizeHermesModelAliases(config.modelAliases, discoveredModels),
    preferredThinkingByModel: normalizeHermesPreferredThinkingByModel(
      config.preferredThinkingByModel,
    ),
    profile: typeof config.profile === 'string' ? config.profile.trim() : DEFAULT_HERMES_PROVIDER_SETTINGS.profile,
    visibleModels: normalizeHermesVisibleModels(config.visibleModels, discoveredModels),
  };
}

export function updateHermesProviderSettings(
  settings: Record<string, unknown>,
  updates: Partial<PersistedHermesProviderSettings>,
): PersistedHermesProviderSettings {
  const current = getHermesProviderSettings(settings);
  const hostnameKey = getHostnameKey();

  const nextDiscoveredModels = updates.discoveredModels !== undefined
    ? normalizeHermesDiscoveredModels(updates.discoveredModels)
    : current.discoveredModels;

  const nextVisibleModels = normalizeHermesVisibleModels(
    updates.visibleModels ?? current.visibleModels,
    nextDiscoveredModels,
  );

  const nextModelAliases = pruneModelAliasesToVisible(
    normalizeHermesModelAliases(
      updates.modelAliases ?? current.modelAliases,
      nextDiscoveredModels,
    ),
    nextVisibleModels,
  );

  const nextCliPathsByHost = 'cliPathsByHost' in updates
    ? normalizeHostnameCliPaths(updates.cliPathsByHost)
    : { ...current.cliPathsByHost };
  let nextCliPath = 'cliPathsByHost' in updates
    ? (
      typeof updates.cliPath === 'string'
        ? updates.cliPath.trim()
        : DEFAULT_HERMES_PROVIDER_SETTINGS.cliPath
    )
    : current.cliPath.trim();

  if ('cliPath' in updates && !('cliPathsByHost' in updates)) {
    const trimmedCliPath = typeof updates.cliPath === 'string' ? updates.cliPath.trim() : '';
    if (trimmedCliPath) {
      nextCliPathsByHost[hostnameKey] = trimmedCliPath;
    } else {
      delete nextCliPathsByHost[hostnameKey];
    }
    nextCliPath = DEFAULT_HERMES_PROVIDER_SETTINGS.cliPath;
  }

  const next: PersistedHermesProviderSettings = {
    ...current,
    ...updates,
    cliPath: nextCliPath,
    cliPathsByHost: nextCliPathsByHost,
    discoveredModels: nextDiscoveredModels,
    modelAliases: nextModelAliases,
    preferredThinkingByModel: normalizeHermesPreferredThinkingByModel(
      updates.preferredThinkingByModel ?? current.preferredThinkingByModel,
    ),
    profile: typeof updates.profile === 'string' ? updates.profile.trim() : current.profile,
    visibleModels: nextVisibleModels,
  };

  setProviderConfig(settings, 'hermes', {
    cliPath: next.cliPath,
    cliPathsByHost: next.cliPathsByHost,
    discoveredModels: next.discoveredModels,
    enabled: next.enabled,
    environmentHash: next.environmentHash,
    environmentVariables: next.environmentVariables,
    modelAliases: next.modelAliases,
    preferredThinkingByModel: next.preferredThinkingByModel,
    profile: next.profile,
    visibleModels: next.visibleModels,
  });

  return next;
}

function pruneModelAliasesToVisible(
  aliases: Record<string, string>,
  visibleModels: string[],
): Record<string, string> {
  if (visibleModels.length === 0 || Object.keys(aliases).length === 0) {
    return {};
  }

  const visibleSet = new Set(visibleModels);
  const pruned: Record<string, string> = {};
  for (const [rawId, alias] of Object.entries(aliases)) {
    if (visibleSet.has(rawId)) {
      pruned[rawId] = alias;
    }
  }
  return pruned;
}
