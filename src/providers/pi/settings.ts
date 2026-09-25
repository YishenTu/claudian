import { selectModelMetadata } from '../../core/providers/models/selectedModelMetadata';
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
  clampPiThinkingLevel,
  decodePiModelId,
  findPiModel,
  normalizePiDiscoveredModels,
  normalizePiThinkingLevel,
  type PiDiscoveredModel,
  type PiThinkingLevel
} from './models';

export type PiToolMode = 'all' | 'readonly';

export interface PersistedPiProviderSettings {
  cliPath: string;
  cliPathsByHost: HostnameCLIPaths;
  discoveredModels: PiDiscoveredModel[];
  enabled: boolean;
  environmentHash: string;
  environmentVariables: string;
  modelAliases: Record<string, string>;
  preferredThinkingByModel: Record<string, PiThinkingLevel>;
  toolMode: PiToolMode;
  visibleModels: string[];
}

export type PiProviderSettings = PersistedPiProviderSettings;

export const DEFAULT_PI_PROVIDER_SETTINGS: Readonly<PersistedPiProviderSettings> = Object.freeze({
  cliPath: '',
  cliPathsByHost: {},
  discoveredModels: [],
  enabled: false,
  environmentHash: '',
  environmentVariables: '',
  modelAliases: {},
  preferredThinkingByModel: {},
  toolMode: 'all',
  visibleModels: [],
});

export function normalizePiVisibleModels(
  value: unknown,
  discoveredModels: PiDiscoveredModel[] = [],
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

    const trimmed = entry.trim();
    if (!trimmed || !decodePiModelId(trimmed)) {
      continue;
    }
    if (seen.has(trimmed)) {
      continue;
    }

    seen.add(trimmed);
    normalized.push(trimmed);
  }

  return normalized;
}

export function normalizePiModelAliases(
  value: unknown,
  discoveredModels: PiDiscoveredModel[] = [],
): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }

  const normalized: Record<string, string> = {};
  for (const [encodedId, alias] of Object.entries(value as Record<string, unknown>)) {
    if (typeof alias !== 'string') {
      continue;
    }

    const normalizedEncodedId = normalizePiEncodedId(encodedId, discoveredModels);
    const normalizedAlias = alias.trim();
    if (!normalizedEncodedId || !normalizedAlias) {
      continue;
    }

    normalized[normalizedEncodedId] = normalizedAlias;
  }

  return normalized;
}

export function normalizePiPreferredThinkingByModel(
  value: unknown,
  discoveredModels: PiDiscoveredModel[] = [],
): Record<string, PiThinkingLevel> {
  return normalizePiPreferredThinkingEntries(
    value,
    discoveredModels,
    encodedId => normalizePiEncodedId(encodedId, discoveredModels),
  );
}

export function getPiProviderSettings(settings: Record<string, unknown>): PiProviderSettings {
  const config = getProviderConfig(settings, 'pi');
  const cliPathsByHost = normalizeHostnameStringMap(config.cliPathsByHost);
  const discoveredModels = normalizePiDiscoveredModels(config.discoveredModels ?? config.selectedModels);
  const visibleModels = normalizePiVisibleModels(config.visibleModels, discoveredModels);
  const persistableIds = getPersistablePiModelIds(settings, visibleModels);

  return {
    cliPath: readStoredString(config.cliPath, DEFAULT_PI_PROVIDER_SETTINGS.cliPath),
    cliPathsByHost,
    discoveredModels,
    enabled: readStoredBoolean(config.enabled, DEFAULT_PI_PROVIDER_SETTINGS.enabled),
    environmentHash: readStoredString(
      config.environmentHash,
      DEFAULT_PI_PROVIDER_SETTINGS.environmentHash,
    ),
    environmentVariables: readStoredString(
      config.environmentVariables,
      getProviderEnvironmentVariables(settings, 'pi')
        ?? DEFAULT_PI_PROVIDER_SETTINGS.environmentVariables,
    ),
    modelAliases: normalizePiModelAliasesForPersistableIds(
      config.modelAliases,
      discoveredModels,
      persistableIds,
    ),
    preferredThinkingByModel: normalizePiPreferredThinkingForPersistableIds(
      config.preferredThinkingByModel,
      discoveredModels,
      persistableIds,
    ),
    toolMode: normalizePiToolMode(config.toolMode),
    visibleModels,
  };
}

export function updatePiProviderSettings(
  settings: Record<string, unknown>,
  updates: Partial<PiProviderSettings>,
): PiProviderSettings {
  const current = getPiProviderSettings(settings);
  const hostnameKey = getHostnameKey();
  const nextDiscoveredModels = normalizePiDiscoveredModels(
    updates.discoveredModels ?? current.discoveredModels,
  );
  const nextVisibleModels = normalizePiVisibleModels(
    updates.visibleModels ?? current.visibleModels,
    nextDiscoveredModels,
  );
  const persistableIds = getPersistablePiModelIds(settings, nextVisibleModels);
  const nextModelAliases = pruneMapToPersistableIds(
    normalizePiModelAliasesForPersistableIds(
      updates.modelAliases ?? current.modelAliases,
      nextDiscoveredModels,
      persistableIds,
    ),
    persistableIds,
  );
  const nextPreferredThinkingByModel = pruneMapToPersistableIds(
    normalizePiPreferredThinkingForPersistableIds(
      updates.preferredThinkingByModel ?? current.preferredThinkingByModel,
      nextDiscoveredModels,
      persistableIds,
    ),
    persistableIds,
  );
  const nextCliPathsByHost = 'cliPathsByHost' in updates
    ? normalizeHostnameStringMap(updates.cliPathsByHost)
    : { ...current.cliPathsByHost };
  let nextCliPath = 'cliPathsByHost' in updates
    ? (
      typeof updates.cliPath === 'string'
        ? updates.cliPath.trim()
        : DEFAULT_PI_PROVIDER_SETTINGS.cliPath
    )
    : current.cliPath.trim();

  if ('cliPath' in updates && !('cliPathsByHost' in updates)) {
    const trimmedCliPath = typeof updates.cliPath === 'string' ? updates.cliPath.trim() : '';
    if (trimmedCliPath) {
      nextCliPathsByHost[hostnameKey] = trimmedCliPath;
    } else {
      delete nextCliPathsByHost[hostnameKey];
    }
    nextCliPath = DEFAULT_PI_PROVIDER_SETTINGS.cliPath;
  }

  const next: PiProviderSettings = {
    ...current,
    ...updates,
    cliPath: nextCliPath,
    cliPathsByHost: nextCliPathsByHost,
    discoveredModels: nextDiscoveredModels,
    modelAliases: nextModelAliases,
    preferredThinkingByModel: nextPreferredThinkingByModel,
    toolMode: normalizePiToolMode(updates.toolMode ?? current.toolMode),
    visibleModels: nextVisibleModels,
  };

  if (updates.visibleModels !== undefined) {
    const retargetedPersistableIds = getPersistablePiModelIds(settings, next.visibleModels);
    next.modelAliases = pruneMapToPersistableIds(next.modelAliases, retargetedPersistableIds);
    next.preferredThinkingByModel = pruneMapToPersistableIds(
      next.preferredThinkingByModel,
      retargetedPersistableIds,
    );
  }

  setProviderConfig(settings, 'pi', {
    cliPath: next.cliPath,
    cliPathsByHost: next.cliPathsByHost,
    discoveredModels: next.discoveredModels,
    enabled: next.enabled,
    environmentHash: next.environmentHash,
    environmentVariables: next.environmentVariables,
    modelAliases: next.modelAliases,
    preferredThinkingByModel: next.preferredThinkingByModel,
    toolMode: next.toolMode,
    visibleModels: next.visibleModels,
  });

  return next;
}

function normalizePiModelAliasesForPersistableIds(
  value: unknown,
  discoveredModels: PiDiscoveredModel[],
  persistableIds: Set<string>,
): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }

  const normalized: Record<string, string> = {};
  for (const [encodedId, alias] of Object.entries(value as Record<string, unknown>)) {
    if (typeof alias !== 'string') {
      continue;
    }

    const normalizedEncodedId = normalizePiPersistableEncodedId(
      encodedId,
      discoveredModels,
      persistableIds,
    );
    const normalizedAlias = alias.trim();
    if (!normalizedEncodedId || !normalizedAlias) {
      continue;
    }

    normalized[normalizedEncodedId] = normalizedAlias;
  }

  return normalized;
}

function normalizePiPreferredThinkingForPersistableIds(
  value: unknown,
  discoveredModels: PiDiscoveredModel[],
  persistableIds: Set<string>,
): Record<string, PiThinkingLevel> {
  return normalizePiPreferredThinkingEntries(
    value,
    discoveredModels,
    encodedId => normalizePiPersistableEncodedId(
      encodedId,
      discoveredModels,
      persistableIds,
    ),
  );
}

function normalizePiPreferredThinkingEntries(
  value: unknown,
  discoveredModels: PiDiscoveredModel[],
  normalizeEncodedId: (encodedId: string) => string,
): Record<string, PiThinkingLevel> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }

  const normalized: Record<string, PiThinkingLevel> = {};
  for (const [encodedId, thinkingLevel] of Object.entries(value as Record<string, unknown>)) {
    const normalizedEncodedId = normalizeEncodedId(encodedId);
    const normalizedThinkingLevel = normalizePiThinkingLevel(thinkingLevel);
    if (!normalizedEncodedId || !normalizedThinkingLevel) {
      continue;
    }

    const discoveredModel = discoveredModels.find(model => model.encodedId === normalizedEncodedId);
    normalized[normalizedEncodedId] = discoveredModel
      ? clampPiThinkingLevel(normalizedThinkingLevel, discoveredModel.thinkingLevels)
      : normalizedThinkingLevel;
  }

  return normalized;
}

export function resolvePiModelAlias(
  settings: PiProviderSettings,
  encodedId: string,
): string | null {
  return settings.modelAliases[encodedId] ?? null;
}

function normalizePiToolMode(value: unknown): PiToolMode {
  if (value === undefined) {
    return 'all';
  }
  return value === 'all' || value === 'readonly' ? value : 'readonly';
}

function normalizePiEncodedId(
  value: string,
  discoveredModels: PiDiscoveredModel[],
): string {
  const trimmed = value.trim();
  const decoded = decodePiModelId(trimmed);
  if (!decoded) {
    return '';
  }

  if (discoveredModels.length === 0) {
    return trimmed;
  }

  const discoveredModel = findPiModel({ discoveredModels }, trimmed);
  return discoveredModel ? discoveredModel.encodedId : '';
}

function normalizePiPersistableEncodedId(
  value: string,
  discoveredModels: PiDiscoveredModel[],
  persistableIds: Set<string>,
): string {
  const trimmed = value.trim();
  const decoded = decodePiModelId(trimmed);
  if (!decoded) {
    return '';
  }

  const discoveredModel = findPiModel({ discoveredModels }, trimmed);
  if (discoveredModel) {
    return discoveredModel.encodedId;
  }

  return persistableIds.has(trimmed) ? trimmed : '';
}

function getPersistablePiModelIds(
  settings: Record<string, unknown>,
  visibleModels: string[],
): Set<string> {
  const persistableIds = new Set(visibleModels);
  addPersistableSelection(persistableIds, settings.model);
  addPersistableSelection(persistableIds, settings.titleGenerationModel);

  const savedProviderModel = settings.savedProviderModel;
  if (savedProviderModel && typeof savedProviderModel === 'object' && !Array.isArray(savedProviderModel)) {
    addPersistableSelection(persistableIds, (savedProviderModel as Record<string, unknown>).pi);
  }

  return persistableIds;
}

function addPersistableSelection(target: Set<string>, value: unknown): void {
  if (typeof value === 'string' && decodePiModelId(value)) {
    target.add(value);
  }
}

function pruneMapToPersistableIds<T extends string>(
  value: Record<string, T>,
  persistableIds: Set<string>,
): Record<string, T> {
  const pruned: Record<string, T> = {};
  for (const [encodedId, entry] of Object.entries(value)) {
    if (persistableIds.has(encodedId)) {
      pruned[encodedId] = entry;
    }
  }
  return pruned;
}

export function projectPiModelSettings(settings: Record<string, unknown>): Record<string, unknown> {
  const current = getPiProviderSettings(settings);
  const visibleModels = current.visibleModels;
  const selected = new Set(visibleModels);
  const config = {
    ...getProviderConfig(settings, 'pi'),
    visibleModels,
    modelAliases: selectModelMetadata(current.modelAliases, selected),
    preferredThinkingByModel: selectModelMetadata(current.preferredThinkingByModel, selected),
    selectedModels: current.discoveredModels.filter(model => selected.has(model.encodedId)),
  };
  for (const key of ['discoveredModels', 'catalogTimestamp', 'catalogFingerprint', 'availableModes']) delete (config as Record<string, unknown>)[key];
  return config;
}
