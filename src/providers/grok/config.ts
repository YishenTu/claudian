import { getInstallationKey } from '@/core/device/InstallationKey';
import { decodeInstallationSettings, type InstallationSettings, selectInstallationSettings, type StoredInstallationSettings,updateInstallationSettings } from '@/core/providers/settings/InstallationSettings';

import { replaceProviderConfig } from '../../core/providers/providerConfig';
import type { ProviderSelectionInputs } from '../../core/providers/ProviderRuntimeHost';
import { normalizeHostnameStringMap } from '../../core/providers/settings/HostnameStringMap';
import type { HostnameCLIPaths } from '../../core/types/settings';
import {
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

export interface PersistedGrokProviderSettings extends StoredInstallationSettings {
  sessionEnvironmentHash: string;
  enabled: boolean;
  cliPath: string;
  cliPathsByHost: HostnameCLIPaths;
  catalogsByHost: Record<string, GrokCatalogSnapshot>;
  environmentVariables: string;
  environmentHash: string;
  visibleModels: string[] | null;
  modelAliases: Record<string, string>;
  preferredReasoningByModel: Record<string, string>;
}

export interface GrokProviderSettings extends PersistedGrokProviderSettings, InstallationSettings {
  currentCatalog: GrokCatalogSnapshot | null;
}

export const DEFAULT_GROK_PROVIDER_SETTINGS: Readonly<PersistedGrokProviderSettings> = Object.freeze({
  installationMethodsByHost: {},
  wslDistroOverridesByHost: {},
  sessionEnvironmentHash: '',
  catalogsByHost: {},
  cliPath: '',
  cliPathsByHost: {},
  enabled: false,
  environmentHash: '',
  environmentVariables: '',
  modelAliases: {},
  preferredReasoningByModel: {},
  visibleModels: [],
});

export function getOrderedGrokVisibleModelIds(
  settings: GrokProviderSettings,
): string[] {
  if (settings.visibleModels !== null) {
    return [...settings.visibleModels];
  }

  const models = settings.currentCatalog?.models ?? [];
  const defaultModelId = settings.currentCatalog?.defaultModelId;
  if (!defaultModelId || !models.some(model => model.rawId === defaultModelId)) {
    return models.map(model => model.rawId);
  }

  return [
    defaultModelId,
    ...models.filter(model => model.rawId !== defaultModelId).map(model => model.rawId),
  ];
}

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

export function decodeGrokConfig(
  config: Readonly<Record<string, unknown>>,
  selection: Pick<ProviderSelectionInputs, 'referencedModelIds'>,
): GrokProviderSettings {
  const currentHostKey = getInstallationKey();
  const cliPathsByHost = normalizeHostnameStringMap(config.cliPathsByHost);
  const catalogsByHost = normalizeGrokCatalogsByHost(config.catalogsByHost ?? config.selectedModelsByHost);
  const currentCatalog = catalogsByHost[currentHostKey] ?? null;
  const selectedModelIds = collectSelectedGrokRawModelIds(selection);
  const catalogModels = currentCatalog?.models ?? [];
  const visibleModels = normalizeGrokVisibleModels(config.visibleModels);
  const allowedModelIds = new Set(catalogModels.map(model => model.rawId));
  for (const id of visibleModels ?? []) allowedModelIds.add(id);
  for (const modelId of selectedModelIds) {
    allowedModelIds.add(modelId);
  }

  const enabledModelIds = new Set(
    visibleModels ?? catalogModels.map(model => model.rawId),
  );

  const installation = decodeInstallationSettings(config);
  return {
    ...installation,
    ...selectInstallationSettings(installation, currentHostKey),
    sessionEnvironmentHash: readTrimmedString(config.sessionEnvironmentHash),
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
      : DEFAULT_GROK_PROVIDER_SETTINGS.environmentVariables,
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

/** Applies updates to a stored Grok configuration in place, normalizing against the current selections. */
export function updateGrokConfig(
  config: Record<string, unknown>,
  selection: Pick<ProviderSelectionInputs, 'referencedModelIds'>,
  updates: Partial<GrokProviderSettings>,
): GrokProviderSettings {
  const current = decodeGrokConfig(config, selection);
  const currentHostKey = getInstallationKey();
  const cliPathsByHost = updates.cliPathsByHost !== undefined
    ? normalizeHostnameStringMap(updates.cliPathsByHost)
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
  for (const id of normalizeGrokVisibleModels(updates.visibleModels ?? current.visibleModels) ?? []) allowedModelIds.add(id);
  for (const modelId of collectSelectedGrokRawModelIds(selection)) {
    allowedModelIds.add(modelId);
  }
  const hasCatalog = catalogModels.length > 0;
  const visibleModels = normalizeGrokVisibleModels(
    updates.visibleModels === undefined ? current.visibleModels : updates.visibleModels,
  );
  const enabledModelIds = new Set(
    visibleModels ?? catalogModels.map(model => model.rawId),
  );

  const installation = updateInstallationSettings(current, updates, currentHostKey);
  const next: PersistedGrokProviderSettings = {
    installationMethodsByHost: installation.installationMethodsByHost,
    wslDistroOverridesByHost: installation.wslDistroOverridesByHost,
    sessionEnvironmentHash: updates.sessionEnvironmentHash ?? current.sessionEnvironmentHash,
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

  replaceProviderConfig(config, next as unknown as Record<string, unknown>);
  return { ...next, ...selectInstallationSettings(next, currentHostKey), currentCatalog };
}

export function updateCurrentGrokCatalogConfig(
  config: Record<string, unknown>,
  selection: Pick<ProviderSelectionInputs, 'referencedModelIds'>,
  snapshot: GrokCatalogSnapshot,
): GrokCatalogSnapshot | null {
  const normalized = normalizeGrokCatalogSnapshot(snapshot);
  if (!normalized) {
    return null;
  }
  const current = decodeGrokConfig(config, selection);
  updateGrokConfig(config, selection, {
    catalogsByHost: {
      ...current.catalogsByHost,
      [getInstallationKey()]: normalized,
    },
  });
  return normalized;
}

function normalizeGrokVisibleModels(value: unknown): string[] | null {
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
    ) {
      continue;
    }
    seen.add(rawModelId);
    normalized.push(rawModelId);
  }
  return normalized;
}

function normalizeGrokModelAliases(
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
    Object.defineProperty(normalized, rawModelId, { value: alias, enumerable: true, writable: true, configurable: true });
  }
  return normalized;
}

function normalizeGrokPreferredReasoningByModel(
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
    if (catalogModel?.reasoningMetadataResolved === true
      && !getGrokAvailableReasoningEfforts(catalogModel).some(option => option.value === effort)) {
      continue;
    }
    Object.defineProperty(normalized, rawModelId, { value: effort, enumerable: true, writable: true, configurable: true });
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

function collectSelectedGrokRawModelIds(
  selection: Pick<ProviderSelectionInputs, 'referencedModelIds'>,
): Set<string> {
  const selected = new Set<string>();
  for (const id of selection.referencedModelIds) {
    const rawModelId = decodeGrokModelId(id.trim());
    if (rawModelId) selected.add(rawModelId);
  }
  return selected;
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

export function getGrokMigratedVisibleModelIds(current: GrokProviderSettings): string[] {
  return current.visibleModels ?? [...new Set([
    ...getOrderedGrokVisibleModelIds(current),
    ...Object.values(current.catalogsByHost).flatMap(catalog => catalog.models.map(model => model.rawId)),
  ])];
}
