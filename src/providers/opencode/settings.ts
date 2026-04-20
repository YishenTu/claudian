import { getProviderConfig, setProviderConfig } from '../../core/providers/providerConfig';
import { getProviderEnvironmentVariables } from '../../core/providers/providerEnvironment';
import type { HostnameCliPaths } from '../../core/types/settings';
import { getHostnameKey } from '../../utils/env';
import {
  normalizeOpencodeDiscoveredModels,
  type OpencodeDiscoveredModel,
  resolveOpencodeBaseModelRawId,
} from './models';
import {
  normalizeOpencodeAvailableModes,
  normalizeOpencodeSelectedMode,
  type OpencodeMode,
} from './modes';

export interface OpencodeProviderSettings {
  availableModes: OpencodeMode[];
  cliPath: string;
  cliPathsByHost: HostnameCliPaths;
  discoveredModels: OpencodeDiscoveredModel[];
  enabled: boolean;
  environmentVariables: string;
  modelAliases: Record<string, string>;
  prewarm: boolean;
  preferredThinkingByModel: Record<string, string>;
  selectedMode: string;
  visibleModels: string[];
}

export const DEFAULT_OPENCODE_PROVIDER_SETTINGS: Readonly<OpencodeProviderSettings> = Object.freeze({
  availableModes: [],
  cliPath: '',
  cliPathsByHost: {},
  discoveredModels: [],
  enabled: false,
  environmentVariables: '',
  modelAliases: {},
  prewarm: true,
  preferredThinkingByModel: {},
  selectedMode: '',
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

export function normalizeOpencodeVisibleModels(
  value: unknown,
  discoveredModels: OpencodeDiscoveredModel[] = [],
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

    const trimmed = resolveOpencodeBaseModelRawId(entry.trim(), discoveredModels);
    if (!trimmed || seen.has(trimmed)) {
      continue;
    }

    seen.add(trimmed);
    normalized.push(trimmed);
  }

  return normalized;
}

export function normalizeOpencodeModelAliases(
  value: unknown,
  discoveredModels: OpencodeDiscoveredModel[] = [],
): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }

  const normalized: Record<string, string> = {};
  for (const [rawId, alias] of Object.entries(value as Record<string, unknown>)) {
    if (typeof alias !== 'string') {
      continue;
    }

    const normalizedRawId = resolveOpencodeBaseModelRawId(rawId.trim(), discoveredModels);
    const normalizedAlias = alias.trim();
    if (!normalizedRawId || !normalizedAlias) {
      continue;
    }

    normalized[normalizedRawId] = normalizedAlias;
  }

  return normalized;
}

export function normalizeOpencodePreferredThinkingByModel(
  value: unknown,
  discoveredModels: OpencodeDiscoveredModel[] = [],
): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }

  const normalized: Record<string, string> = {};
  for (const [rawId, thinkingLevel] of Object.entries(value as Record<string, unknown>)) {
    if (typeof thinkingLevel !== 'string') {
      continue;
    }

    const normalizedRawId = resolveOpencodeBaseModelRawId(rawId.trim(), discoveredModels);
    const normalizedThinkingLevel = thinkingLevel.trim();
    if (!normalizedRawId || !normalizedThinkingLevel) {
      continue;
    }

    normalized[normalizedRawId] = normalizedThinkingLevel;
  }

  return normalized;
}

export function getOpencodeProviderSettings(
  settings: Record<string, unknown>,
): OpencodeProviderSettings {
  const config = getProviderConfig(settings, 'opencode');
  const availableModes = normalizeOpencodeAvailableModes(config.availableModes);
  const discoveredModels = normalizeOpencodeDiscoveredModels(config.discoveredModels);

  return {
    availableModes,
    cliPath: (config.cliPath as string | undefined)
      ?? DEFAULT_OPENCODE_PROVIDER_SETTINGS.cliPath,
    cliPathsByHost: normalizeHostnameCliPaths(config.cliPathsByHost),
    discoveredModels,
    enabled: (config.enabled as boolean | undefined)
      ?? DEFAULT_OPENCODE_PROVIDER_SETTINGS.enabled,
    environmentVariables: (config.environmentVariables as string | undefined)
      ?? getProviderEnvironmentVariables(settings, 'opencode')
      ?? DEFAULT_OPENCODE_PROVIDER_SETTINGS.environmentVariables,
    modelAliases: normalizeOpencodeModelAliases(config.modelAliases, discoveredModels),
    prewarm: (config.prewarm as boolean | undefined)
      ?? DEFAULT_OPENCODE_PROVIDER_SETTINGS.prewarm,
    preferredThinkingByModel: normalizeOpencodePreferredThinkingByModel(
      config.preferredThinkingByModel,
      discoveredModels,
    ),
    selectedMode: normalizeOpencodeSelectedMode(config.selectedMode),
    visibleModels: normalizeOpencodeVisibleModels(config.visibleModels, discoveredModels),
  };
}

export function updateOpencodeProviderSettings(
  settings: Record<string, unknown>,
  updates: Partial<OpencodeProviderSettings>,
): OpencodeProviderSettings {
  const current = getOpencodeProviderSettings(settings);
  const hostnameKey = getHostnameKey();
  const nextAvailableModes = normalizeOpencodeAvailableModes(
    updates.availableModes ?? current.availableModes,
  );
  const nextDiscoveredModels = normalizeOpencodeDiscoveredModels(
    updates.discoveredModels ?? current.discoveredModels,
  );
  const nextSelectedMode = normalizeOpencodeSelectedMode(
    updates.selectedMode ?? current.selectedMode,
  );
  const nextVisibleModels = normalizeOpencodeVisibleModels(
    updates.visibleModels ?? current.visibleModels,
    nextDiscoveredModels,
  );
  const nextModelAliases = pruneModelAliasesToVisible(
    normalizeOpencodeModelAliases(
      updates.modelAliases ?? current.modelAliases,
      nextDiscoveredModels,
    ),
    nextVisibleModels,
  );
  const nextCliPathsByHost = 'cliPathsByHost' in updates
    ? normalizeHostnameCliPaths(updates.cliPathsByHost)
    : { ...current.cliPathsByHost };

  if (
    Object.keys(nextCliPathsByHost).length === 0
    && current.cliPath.trim()
  ) {
    nextCliPathsByHost[hostnameKey] = current.cliPath.trim();
  }

  if ('cliPath' in updates) {
    const trimmedCliPath = typeof updates.cliPath === 'string' ? updates.cliPath.trim() : '';
    if (trimmedCliPath) {
      nextCliPathsByHost[hostnameKey] = trimmedCliPath;
    } else {
      delete nextCliPathsByHost[hostnameKey];
    }
  }

  const next: OpencodeProviderSettings = {
    ...current,
    ...updates,
    availableModes: nextAvailableModes,
    cliPathsByHost: nextCliPathsByHost,
    discoveredModels: nextDiscoveredModels,
    modelAliases: nextModelAliases,
    preferredThinkingByModel: normalizeOpencodePreferredThinkingByModel(
      updates.preferredThinkingByModel ?? current.preferredThinkingByModel,
      nextDiscoveredModels,
    ),
    selectedMode: (
      nextSelectedMode
      && updates.availableModes !== undefined
      && nextAvailableModes.length > 0
      && !nextAvailableModes.some((mode) => mode.id === nextSelectedMode)
    )
      ? (nextAvailableModes[0]?.id ?? '')
      : nextSelectedMode,
    visibleModels: nextVisibleModels,
  };

  setProviderConfig(settings, 'opencode', {
    availableModes: next.availableModes,
    cliPath: next.cliPath,
    cliPathsByHost: next.cliPathsByHost,
    discoveredModels: next.discoveredModels,
    enabled: next.enabled,
    environmentVariables: next.environmentVariables,
    modelAliases: next.modelAliases,
    prewarm: next.prewarm,
    preferredThinkingByModel: next.preferredThinkingByModel,
    selectedMode: next.selectedMode,
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
