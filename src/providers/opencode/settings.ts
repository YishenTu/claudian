import { getProviderConfig, setProviderConfig } from '../../core/providers/providerConfig';
import { getProviderEnvironmentVariables } from '../../core/providers/providerEnvironment';
import type { HostnameCliPaths } from '../../core/types/settings';
import { getHostnameKey } from '../../utils/env';
import {
  getOpencodeDiscoveryState,
  seedOpencodeDiscoveryStateFromLegacyConfig,
  updateOpencodeDiscoveryState,
} from './discoveryState';
import { ensureProviderProjectionMap } from './internal/providerProjection';
import {
  decodeOpencodeModelId,
  encodeOpencodeModelId,
  isOpencodeModelSelectionId,
  OPENCODE_DEFAULT_THINKING_LEVEL,
  type OpencodeDiscoveredModel,
  resolveOpencodeBaseModelRawId,
} from './models';
import {
  normalizeManagedOpencodeSelectedMode,
  type OpencodeMode,
} from './modes';

export interface PersistedOpencodeProviderSettings {
  cliPath: string;
  cliPathsByHost: HostnameCliPaths;
  enabled: boolean;
  environmentVariables: string;
  modelAliases: Record<string, string>;
  preferredThinkingByModel: Record<string, string>;
  selectedMode: string;
  visibleModels: string[];
}

export interface OpencodeProviderSettings extends PersistedOpencodeProviderSettings {
  availableModes: OpencodeMode[];
  discoveredModels: OpencodeDiscoveredModel[];
}

export const OPENCODE_DEFAULT_ENVIRONMENT_VARIABLES = 'OPENCODE_ENABLE_EXA=1';

export const DEFAULT_OPENCODE_PROVIDER_SETTINGS: Readonly<PersistedOpencodeProviderSettings> = Object.freeze({
  cliPath: '',
  cliPathsByHost: {},
  enabled: false,
  environmentVariables: OPENCODE_DEFAULT_ENVIRONMENT_VARIABLES,
  modelAliases: {},
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
  seedOpencodeDiscoveryStateFromLegacyConfig(settings, config);
  const discoveryState = getOpencodeDiscoveryState(settings);
  const availableModes = discoveryState.availableModes;
  const discoveredModels = discoveryState.discoveredModels;

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
    preferredThinkingByModel: normalizeOpencodePreferredThinkingByModel(
      config.preferredThinkingByModel,
      discoveredModels,
    ),
    selectedMode: normalizeManagedOpencodeSelectedMode(config.selectedMode, availableModes),
    visibleModels: normalizeOpencodeVisibleModels(config.visibleModels, discoveredModels),
  };
}

export function updateOpencodeProviderSettings(
  settings: Record<string, unknown>,
  updates: Partial<OpencodeProviderSettings>,
): OpencodeProviderSettings {
  const current = getOpencodeProviderSettings(settings);
  const hostnameKey = getHostnameKey();
  if ('availableModes' in updates || 'discoveredModels' in updates) {
    updateOpencodeDiscoveryState(settings, {
      ...(updates.availableModes !== undefined ? { availableModes: updates.availableModes } : {}),
      ...(updates.discoveredModels !== undefined ? { discoveredModels: updates.discoveredModels } : {}),
    });
  }
  const discoveryState = getOpencodeDiscoveryState(settings);
  const nextAvailableModes = discoveryState.availableModes;
  const nextDiscoveredModels = discoveryState.discoveredModels;
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
    selectedMode: nextSelectedMode,
    visibleModels: nextVisibleModels,
  };

  if (updates.visibleModels !== undefined) {
    retargetRemovedOpencodeSelections(settings, next);
  }

  setProviderConfig(settings, 'opencode', {
    cliPath: next.cliPath,
    cliPathsByHost: next.cliPathsByHost,
    enabled: next.enabled,
    environmentVariables: next.environmentVariables,
    modelAliases: next.modelAliases,
    preferredThinkingByModel: next.preferredThinkingByModel,
    selectedMode: next.selectedMode,
    visibleModels: next.visibleModels,
  });

  return next;
}

export function hasLegacyOpencodeDiscoveryFields(settings: Record<string, unknown>): boolean {
  const config = getProviderConfig(settings, 'opencode');
  return 'availableModes' in config || 'discoveredModels' in config;
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

function retargetRemovedOpencodeSelections(
  settings: Record<string, unknown>,
  next: OpencodeProviderSettings,
): void {
  if (next.visibleModels.length === 0) {
    return;
  }

  const visibleSet = new Set(next.visibleModels);
  const fallbackRawId = next.visibleModels[0];
  const fallbackModelId = encodeOpencodeModelId(fallbackRawId);
  const fallbackEffort = next.preferredThinkingByModel[fallbackRawId] ?? OPENCODE_DEFAULT_THINKING_LEVEL;

  const maybeRetargetModel = (value: unknown): string | null => {
    if (typeof value !== 'string' || !isOpencodeModelSelectionId(value)) {
      return null;
    }

    const rawModelId = decodeOpencodeModelId(value);
    if (!rawModelId) {
      return fallbackModelId;
    }

    const baseRawId = resolveOpencodeBaseModelRawId(rawModelId, next.discoveredModels);
    return visibleSet.has(baseRawId) ? null : fallbackModelId;
  };

  const savedProviderModel = ensureProviderProjectionMap(settings, 'savedProviderModel');
  const nextSavedModel = maybeRetargetModel(savedProviderModel.opencode);
  if (nextSavedModel) {
    savedProviderModel.opencode = nextSavedModel;
    ensureProviderProjectionMap(settings, 'savedProviderEffort').opencode = fallbackEffort;
  }

  const nextTopLevelModel = maybeRetargetModel(settings.model);
  if (nextTopLevelModel) {
    settings.model = nextTopLevelModel;
    settings.effortLevel = fallbackEffort;
  }
}
