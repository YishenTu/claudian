import { getProviderConfig, setProviderConfig } from '../../core/providers/providerConfig';
import { getProviderEnvironmentVariables } from '../../core/providers/providerEnvironment';
import { normalizeHostnameStringMap } from '../../core/providers/settings/HostnameStringMap';
import {
  readStoredBoolean,
  readStoredString,
} from '../../core/providers/settings/storedSettings';
import type { HostnameCLIPaths } from '../../core/types/settings';
import { getHostnameKey } from '../../utils/env';
import {
  getOpencodeDiscoveryState,
  updateOpencodeDiscoveryState,
} from './discoveryState';
import {
  normalizeOpencodeThinkingOptionsByModel,
  type OpencodeDiscoveredModel,
  type OpencodeThinkingOptionsByModel,
  resolveOpencodeBaseModelRawId
} from './models';
import {
  normalizeManagedOpencodeSelectedMode,
  type OpencodeMode,
} from './modes';

export interface PersistedOpencodeProviderSettings {
  cliPath: string;
  cliPathsByHost: HostnameCLIPaths;
  enabled: boolean;
  environmentHash: string;
  environmentVariables: string;
  modelAliases: Record<string, string>;
  preferredThinkingByModel: Record<string, string>;
  selectedMode: string;
  thinkingOptionsByModel: OpencodeThinkingOptionsByModel;
  visibleModels: string[];
}

export interface OpencodeProviderSettings extends PersistedOpencodeProviderSettings {
  availableModes: OpencodeMode[];
  discoveredModels: OpencodeDiscoveredModel[];
}

export const DEFAULT_OPENCODE_PROVIDER_SETTINGS: Readonly<PersistedOpencodeProviderSettings> = Object.freeze({
  cliPath: '',
  cliPathsByHost: {},
  enabled: false,
  environmentHash: '',
  environmentVariables: '',
  modelAliases: {},
  preferredThinkingByModel: {},
  selectedMode: '',
  thinkingOptionsByModel: {},
  visibleModels: [],
});

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
  const cliPathsByHost = normalizeHostnameStringMap(config.cliPathsByHost);
  const discoveryState = getOpencodeDiscoveryState(settings);
  const availableModes = discoveryState.availableModes;
  const discoveredModels = discoveryState.discoveredModels;
  const persistedThinkingOptionsByModel = normalizeOpencodeThinkingOptionsByModel(
    config.thinkingOptionsByModel,
    discoveredModels,
  );
  const thinkingOptionsByModel = normalizeOpencodeThinkingOptionsByModel({
    ...persistedThinkingOptionsByModel,
    ...discoveryState.thinkingOptionsByModel,
  }, discoveredModels);

  return {
    availableModes,
    cliPath: readStoredString(config.cliPath, DEFAULT_OPENCODE_PROVIDER_SETTINGS.cliPath),
    cliPathsByHost,
    discoveredModels,
    enabled: readStoredBoolean(config.enabled, DEFAULT_OPENCODE_PROVIDER_SETTINGS.enabled),
    environmentHash: readStoredString(
      config.environmentHash,
      DEFAULT_OPENCODE_PROVIDER_SETTINGS.environmentHash,
    ),
    environmentVariables: readStoredString(
      config.environmentVariables,
      getProviderEnvironmentVariables(settings, 'opencode')
        ?? DEFAULT_OPENCODE_PROVIDER_SETTINGS.environmentVariables,
    ),
    modelAliases: normalizeOpencodeModelAliases(config.modelAliases, discoveredModels),
    preferredThinkingByModel: normalizeOpencodePreferredThinkingByModel(
      config.preferredThinkingByModel,
      discoveredModels,
    ),
    selectedMode: normalizeManagedOpencodeSelectedMode(config.selectedMode, availableModes),
    thinkingOptionsByModel,
    visibleModels: normalizeOpencodeVisibleModels(config.visibleModels, discoveredModels),
  };
}

export function updateOpencodeProviderSettings(
  settings: Record<string, unknown>,
  updates: Partial<OpencodeProviderSettings>,
): OpencodeProviderSettings {
  const current = getOpencodeProviderSettings(settings);
  const hostnameKey = getHostnameKey();
  if ('availableModes' in updates || 'discoveredModels' in updates || 'thinkingOptionsByModel' in updates) {
    updateOpencodeDiscoveryState(settings, {
      ...(updates.availableModes !== undefined ? { availableModes: updates.availableModes } : {}),
      ...(updates.discoveredModels !== undefined ? { discoveredModels: updates.discoveredModels } : {}),
      ...(updates.thinkingOptionsByModel !== undefined
        ? { thinkingOptionsByModel: updates.thinkingOptionsByModel }
        : {}),
    });
  }
  const discoveryState = getOpencodeDiscoveryState(settings);
  const nextAvailableModes = discoveryState.availableModes;
  const nextDiscoveredModels = discoveryState.discoveredModels;
  const nextThinkingOptionsByModel = updates.thinkingOptionsByModel !== undefined
    ? discoveryState.thinkingOptionsByModel
    : normalizeOpencodeThinkingOptionsByModel(
      current.thinkingOptionsByModel,
      nextDiscoveredModels,
    );
  const nextSelectedMode = normalizeManagedOpencodeSelectedMode(
    updates.selectedMode ?? current.selectedMode,
    nextAvailableModes,
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
    ? normalizeHostnameStringMap(updates.cliPathsByHost)
    : { ...current.cliPathsByHost };
  let nextCliPath = 'cliPathsByHost' in updates
    ? (
      typeof updates.cliPath === 'string'
        ? updates.cliPath.trim()
        : DEFAULT_OPENCODE_PROVIDER_SETTINGS.cliPath
    )
    : current.cliPath.trim();

  if ('cliPath' in updates && !('cliPathsByHost' in updates)) {
    const trimmedCliPath = typeof updates.cliPath === 'string' ? updates.cliPath.trim() : '';
    if (trimmedCliPath) {
      nextCliPathsByHost[hostnameKey] = trimmedCliPath;
    } else {
      delete nextCliPathsByHost[hostnameKey];
    }
    nextCliPath = DEFAULT_OPENCODE_PROVIDER_SETTINGS.cliPath;
  }

  const next: OpencodeProviderSettings = {
    ...current,
    ...updates,
    availableModes: nextAvailableModes,
    cliPath: nextCliPath,
    cliPathsByHost: nextCliPathsByHost,
    discoveredModels: nextDiscoveredModels,
    modelAliases: nextModelAliases,
    preferredThinkingByModel: normalizeOpencodePreferredThinkingByModel(
      updates.preferredThinkingByModel ?? current.preferredThinkingByModel,
      nextDiscoveredModels,
    ),
    selectedMode: nextSelectedMode,
    thinkingOptionsByModel: nextThinkingOptionsByModel,
    visibleModels: nextVisibleModels,
  };

  setProviderConfig(settings, 'opencode', {
    ...getProviderConfig(settings, 'opencode'),
    availableModes: nextAvailableModes,
    discoveredModels: nextDiscoveredModels,
    cliPath: next.cliPath,
    cliPathsByHost: next.cliPathsByHost,
    enabled: next.enabled,
    environmentHash: next.environmentHash,
    environmentVariables: next.environmentVariables,
    modelAliases: next.modelAliases,
    preferredThinkingByModel: next.preferredThinkingByModel,
    selectedMode: next.selectedMode,
    thinkingOptionsByModel: nextThinkingOptionsByModel,
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

function pruneThinkingOptionsToPersistedSelections(
  next: OpencodeProviderSettings,
): OpencodeThinkingOptionsByModel {
  const persistableRawIds = new Set(next.visibleModels);
  const pruned: OpencodeThinkingOptionsByModel = {};
  for (const rawId of persistableRawIds) {
    const options = next.thinkingOptionsByModel[rawId];
    if (options?.length) {
      pruned[rawId] = options.map((option) => ({ ...option }));
    }
  }
  return pruned;
}

export function projectOpencodeModelSettings(settings: Record<string, unknown>): Record<string, unknown> {
  const current = getOpencodeProviderSettings(settings);
  const visibleModels = current.visibleModels;
  const selected = new Set(visibleModels);
  const config = { ...getProviderConfig(settings, 'opencode'), visibleModels, thinkingOptionsByModel: pruneThinkingOptionsToPersistedSelections(current), selectedModels: current.discoveredModels.filter(model => selected.has(resolveOpencodeBaseModelRawId(model.rawId, current.discoveredModels))) };
  for (const key of ['discoveredModels', 'catalogTimestamp', 'catalogFingerprint', 'availableModes']) delete (config as Record<string, unknown>)[key];
  return config;
}
