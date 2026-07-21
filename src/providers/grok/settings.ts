import { getProviderConfig, setProviderConfig } from '../../core/providers/providerConfig';
import { getProviderEnvironmentVariables } from '../../core/providers/providerEnvironment';
import { STANDARD_REASONING_VALUES } from '../../core/providers/reasoning';
import type { HostnameCliPaths } from '../../core/types/settings';
import {
  getHostnameKey,
  getLegacyHostnameKey,
  migrateLegacyHostnameKeyedMap,
} from '../../utils/env';
import {
  clearGrokReasoningMetadata,
  decodeGrokModelId,
  getGrokAvailableReasoningEfforts,
  type GrokDiscoveredModel,
  normalizeGrokDiscoveredModels,
} from './models';

export interface GrokCatalogSnapshot {
  models: GrokDiscoveredModel[];
  defaultModelId: string | null;
  fingerprint: string;
  refreshedAt: number;
}

export interface PersistedGrokProviderSettings {
  enabled: boolean;
  cliPath: string;
  cliPathsByHost: HostnameCliPaths;
  catalogsByHost: Record<string, GrokCatalogSnapshot>;
  environmentVariables: string;
  environmentHash: string;
  visibleModels: string[] | null;
  modelAliases: Record<string, string>;
  preferredReasoningByModel: Record<string, string>;
}

export interface GrokProviderSettings extends PersistedGrokProviderSettings {
  currentCatalog: GrokCatalogSnapshot | null;
}

export const DEFAULT_GROK_PROVIDER_SETTINGS: Readonly<PersistedGrokProviderSettings> = Object.freeze({
  catalogsByHost: {},
  cliPath: '',
  cliPathsByHost: {},
  enabled: false,
  environmentHash: '',
  environmentVariables: '',
  modelAliases: {},
  preferredReasoningByModel: {},
  visibleModels: null,
});

export function normalizeGrokCatalogSnapshot(value: unknown): GrokCatalogSnapshot | null {
  if (!isRecord(value)) {
    return null;
  }

  const defaultModelId = normalizeRawModelId(value.defaultModelId);
  const fingerprint = readTrimmedString(value.fingerprint);
  const refreshedAt = typeof value.refreshedAt === 'number'
    && Number.isFinite(value.refreshedAt)
    && value.refreshedAt >= 0
    ? Math.floor(value.refreshedAt)
    : 0;

  return {
    defaultModelId,
    fingerprint,
    models: normalizeGrokDiscoveredModels(value.models),
    refreshedAt,
  };
}

export function getGrokProviderSettings(
  settings: Record<string, unknown>,
): GrokProviderSettings {
  const config = getProviderConfig(settings, 'grok');
  const currentHostKey = getHostnameKey();
  const legacyHostKey = getLegacyHostnameKey();
  const cliPathsByHost = migrateLegacyHostnameKeyedMap(
    normalizeHostnameCliPaths(config.cliPathsByHost),
    currentHostKey,
    legacyHostKey,
  );
  const catalogsByHost = migrateLegacyGrokCatalogs(
    normalizeGrokCatalogsByHost(config.catalogsByHost),
    currentHostKey,
    legacyHostKey,
  );
  const currentCatalog = catalogsByHost[currentHostKey] ?? null;
  const selectedModelIds = collectSelectedGrokRawModelIds(settings);
  const catalogModels = currentCatalog?.models ?? [];
  const allowedModelIds = new Set(catalogModels.map(model => model.rawId));
  for (const modelId of selectedModelIds) {
    allowedModelIds.add(modelId);
  }

  const visibleModels = normalizeGrokVisibleModels(
    config.visibleModels,
    allowedModelIds,
    catalogModels.length > 0,
  );
  const enabledModelIds = new Set(
    visibleModels ?? catalogModels.map(model => model.rawId),
  );

  return {
    catalogsByHost,
    cliPath: readTrimmedString(config.cliPath)
      || DEFAULT_GROK_PROVIDER_SETTINGS.cliPath,
    cliPathsByHost,
    currentCatalog,
    enabled: typeof config.enabled === 'boolean'
      ? config.enabled
      : DEFAULT_GROK_PROVIDER_SETTINGS.enabled,
    environmentHash: readTrimmedString(config.environmentHash),
    environmentVariables: typeof config.environmentVariables === 'string'
      ? config.environmentVariables
      : getProviderEnvironmentVariables(settings, 'grok')
        ?? DEFAULT_GROK_PROVIDER_SETTINGS.environmentVariables,
    modelAliases: normalizeGrokModelAliases(
      config.modelAliases,
      allowedModelIds,
      catalogModels.length > 0,
    ),
    preferredReasoningByModel: normalizeGrokPreferredReasoningByModel(
      config.preferredReasoningByModel,
      enabledModelIds,
      catalogModels,
      true,
    ),
    visibleModels,
  };
}

export function updateGrokProviderSettings(
  settings: Record<string, unknown>,
  updates: Partial<PersistedGrokProviderSettings>,
): GrokProviderSettings {
  const current = getGrokProviderSettings(settings);
  const currentHostKey = getHostnameKey();
  const cliPathsByHost = updates.cliPathsByHost !== undefined
    ? normalizeHostnameCliPaths(updates.cliPathsByHost)
    : { ...current.cliPathsByHost };
  let cliPath = updates.cliPathsByHost !== undefined
    ? readTrimmedString(updates.cliPath)
    : current.cliPath;

  if ('cliPath' in updates && updates.cliPathsByHost === undefined) {
    const hostCliPath = readTrimmedString(updates.cliPath);
    if (hostCliPath) {
      cliPathsByHost[currentHostKey] = hostCliPath;
    } else {
      delete cliPathsByHost[currentHostKey];
    }
    cliPath = DEFAULT_GROK_PROVIDER_SETTINGS.cliPath;
  }

  const catalogsByHost = updates.catalogsByHost !== undefined
    ? normalizeGrokCatalogsByHost(updates.catalogsByHost)
    : { ...current.catalogsByHost };
  const currentCatalog = catalogsByHost[currentHostKey] ?? null;
  const catalogModels = currentCatalog?.models ?? [];
  const allowedModelIds = new Set(catalogModels.map(model => model.rawId));
  for (const modelId of collectSelectedGrokRawModelIds(settings)) {
    allowedModelIds.add(modelId);
  }
  const hasCatalog = catalogModels.length > 0;
  const visibleModels = normalizeGrokVisibleModels(
    updates.visibleModels === undefined ? current.visibleModels : updates.visibleModels,
    allowedModelIds,
    hasCatalog,
  );
  const enabledModelIds = new Set(
    visibleModels ?? catalogModels.map(model => model.rawId),
  );

  const next: PersistedGrokProviderSettings = {
    catalogsByHost,
    cliPath,
    cliPathsByHost,
    enabled: updates.enabled ?? current.enabled,
    environmentHash: updates.environmentHash !== undefined
      ? readTrimmedString(updates.environmentHash)
      : current.environmentHash,
    environmentVariables: updates.environmentVariables ?? current.environmentVariables,
    modelAliases: normalizeGrokModelAliases(
      updates.modelAliases ?? current.modelAliases,
      allowedModelIds,
      hasCatalog,
    ),
    preferredReasoningByModel: normalizeGrokPreferredReasoningByModel(
      updates.preferredReasoningByModel ?? current.preferredReasoningByModel,
      enabledModelIds,
      catalogModels,
      true,
    ),
    visibleModels,
  };

  setProviderConfig(settings, 'grok', next as unknown as Record<string, unknown>);
  return { ...next, currentCatalog };
}

export function updateGrokVisibleModels(
  settings: Record<string, unknown>,
  visibleModels: string[] | null,
): GrokProviderSettings {
  const current = getGrokProviderSettings(settings);
  const normalizedVisibleModels = normalizeGrokVisibleModels(
    visibleModels,
    new Set(current.currentCatalog?.models.map(model => model.rawId) ?? []),
    Boolean(current.currentCatalog?.models.length),
  );
  const enabledModelIds = new Set(
    normalizedVisibleModels
      ?? current.currentCatalog?.models.map(model => model.rawId)
      ?? [],
  );
  const catalogsByHost = Object.fromEntries(
    Object.entries(current.catalogsByHost).map(([hostKey, catalog]) => [
      hostKey,
      {
        ...catalog,
        models: catalog.models.map(model => (
          normalizedVisibleModels === null || enabledModelIds.has(model.rawId)
            ? model
            : clearGrokReasoningMetadata(model)
        )),
      },
    ]),
  );
  return updateGrokProviderSettings(settings, {
    catalogsByHost,
    preferredReasoningByModel: current.preferredReasoningByModel,
    visibleModels: normalizedVisibleModels,
  });
}

export function getCurrentGrokCatalog(
  settings: Record<string, unknown>,
): GrokCatalogSnapshot | null {
  return getGrokProviderSettings(settings).currentCatalog;
}

export function updateCurrentGrokCatalog(
  settings: Record<string, unknown>,
  snapshot: GrokCatalogSnapshot,
): GrokCatalogSnapshot | null {
  const normalized = normalizeGrokCatalogSnapshot(snapshot);
  if (!normalized) {
    return null;
  }
  const current = getGrokProviderSettings(settings);
  updateGrokProviderSettings(settings, {
    catalogsByHost: {
      ...current.catalogsByHost,
      [getHostnameKey()]: normalized,
    },
  });
  return normalized;
}

export function clearCurrentGrokCatalog(settings: Record<string, unknown>): boolean {
  const current = getGrokProviderSettings(settings);
  const currentHostKey = getHostnameKey();
  if (!current.catalogsByHost[currentHostKey]) {
    return false;
  }

  const catalogsByHost = { ...current.catalogsByHost };
  delete catalogsByHost[currentHostKey];
  updateGrokProviderSettings(settings, { catalogsByHost });
  return true;
}

export function normalizeGrokVisibleModels(
  value: unknown,
  allowedModelIds: ReadonlySet<string> = new Set(),
  restrictToAllowed = allowedModelIds.size > 0,
): string[] | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (!Array.isArray(value)) {
    return null;
  }

  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    const rawModelId = normalizeRawModelId(entry);
    if (
      !rawModelId
      || seen.has(rawModelId)
      || (restrictToAllowed && !allowedModelIds.has(rawModelId))
    ) {
      continue;
    }
    seen.add(rawModelId);
    normalized.push(rawModelId);
  }
  return normalized;
}

export function normalizeGrokModelAliases(
  value: unknown,
  allowedModelIds: ReadonlySet<string> = new Set(),
  restrictToAllowed = allowedModelIds.size > 0,
): Record<string, string> {
  if (!isRecord(value)) {
    return {};
  }

  const normalized: Record<string, string> = {};
  for (const [modelId, aliasValue] of Object.entries(value)) {
    const rawModelId = normalizeRawModelId(modelId);
    const alias = readTrimmedString(aliasValue);
    if (
      !rawModelId
      || !alias
      || (restrictToAllowed && !allowedModelIds.has(rawModelId))
    ) {
      continue;
    }
    normalized[rawModelId] = alias;
  }
  return normalized;
}

export function normalizeGrokPreferredReasoningByModel(
  value: unknown,
  allowedModelIds: ReadonlySet<string> = new Set(),
  catalogModels: GrokDiscoveredModel[] = [],
  restrictToAllowed = catalogModels.length > 0,
): Record<string, string> {
  if (!isRecord(value)) {
    return {};
  }

  const catalogById = new Map(catalogModels.map(model => [model.rawId, model] as const));
  const normalized: Record<string, string> = {};
  for (const [modelId, effortValue] of Object.entries(value)) {
    const rawModelId = normalizeRawModelId(modelId);
    const effort = readTrimmedString(effortValue);
    if (
      !rawModelId
      || !effort
      || (restrictToAllowed && !allowedModelIds.has(rawModelId))
    ) {
      continue;
    }

    const catalogModel = catalogById.get(rawModelId);
    const supportedEfforts = new Set(catalogModel
      ? getGrokAvailableReasoningEfforts(catalogModel).map(option => option.value)
      : STANDARD_REASONING_VALUES);
    if (!supportedEfforts.has(effort)) {
      continue;
    }
    normalized[rawModelId] = effort;
  }
  return normalized;
}

function normalizeGrokCatalogsByHost(
  value: unknown,
): Record<string, GrokCatalogSnapshot> {
  if (!isRecord(value)) {
    return {};
  }

  const normalized: Record<string, GrokCatalogSnapshot> = {};
  for (const [hostKey, snapshot] of Object.entries(value)) {
    const normalizedHostKey = hostKey.trim();
    const normalizedSnapshot = normalizeGrokCatalogSnapshot(snapshot);
    if (normalizedHostKey && normalizedSnapshot) {
      normalized[normalizedHostKey] = normalizedSnapshot;
    }
  }
  return normalized;
}

function normalizeHostnameCliPaths(value: unknown): HostnameCliPaths {
  if (!isRecord(value)) {
    return {};
  }

  const normalized: HostnameCliPaths = {};
  for (const [hostKey, cliPath] of Object.entries(value)) {
    const normalizedHostKey = hostKey.trim();
    const normalizedCliPath = readTrimmedString(cliPath);
    if (normalizedHostKey && normalizedCliPath) {
      normalized[normalizedHostKey] = normalizedCliPath;
    }
  }
  return normalized;
}

function migrateLegacyGrokCatalogs(
  catalogsByHost: Record<string, GrokCatalogSnapshot>,
  currentHostKey: string,
  legacyHostKey: string,
): Record<string, GrokCatalogSnapshot> {
  if (
    !currentHostKey
    || !legacyHostKey
    || currentHostKey === legacyHostKey
    || !Object.prototype.hasOwnProperty.call(catalogsByHost, legacyHostKey)
  ) {
    return catalogsByHost;
  }

  const migrated = { ...catalogsByHost };
  if (!Object.prototype.hasOwnProperty.call(migrated, currentHostKey)) {
    migrated[currentHostKey] = migrated[legacyHostKey];
  }
  delete migrated[legacyHostKey];
  return migrated;
}

function collectSelectedGrokRawModelIds(settings: Record<string, unknown>): Set<string> {
  const selected = new Set<string>();
  addSelectedGrokRawModelId(selected, settings.model);
  addSelectedGrokRawModelId(selected, settings.titleGenerationModel);

  if (isRecord(settings.savedProviderModel)) {
    addSelectedGrokRawModelId(selected, settings.savedProviderModel.grok);
  }
  return selected;
}

function addSelectedGrokRawModelId(target: Set<string>, value: unknown): void {
  if (typeof value !== 'string') {
    return;
  }
  const rawModelId = decodeGrokModelId(value.trim());
  if (rawModelId) {
    target.add(rawModelId);
  }
}

function normalizeRawModelId(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const normalized = value.trim();
  if (!normalized) {
    return null;
  }
  return decodeGrokModelId(normalized) ?? normalized;
}

function readTrimmedString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
