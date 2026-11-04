import { getInstallationKey } from '@/core/device/InstallationKey';

import { replaceProviderConfig } from '../../core/providers/providerConfig';
import type { ProviderSelectionInputs } from '../../core/providers/ProviderRuntimeHost';
import { normalizeHostnameStringMap } from '../../core/providers/settings/HostnameStringMap';
import type { HostnameCLIPaths } from '../../core/types/settings';
import {
  type AntigravityModel,
  decodeAntigravityModelId,
  normalizeAntigravityModels,
} from './models';

export interface AntigravityCatalogSnapshot {
  defaultModelId: string | null;
  models: AntigravityModel[];
  refreshedAt: number;
}

export interface PersistedAntigravityProviderSettings {
  catalogsByHost: Record<string, AntigravityCatalogSnapshot>;
  cliPath: string;
  cliPathsByHost: HostnameCLIPaths;
  enabled: boolean;
  environmentHash: string;
  environmentVariables: string;
  modelAliases: Record<string, string>;
  preferredReasoningByModel: Record<string, string>;
  /** Fingerprint of the native store location; a change retires session bindings. */
  sessionStoreHash: string;
  visibleModels: string[] | null;
}

export interface AntigravityProviderSettings extends PersistedAntigravityProviderSettings {
  currentCatalog: AntigravityCatalogSnapshot | null;
}

export const DEFAULT_ANTIGRAVITY_PROVIDER_SETTINGS: Readonly<PersistedAntigravityProviderSettings> = Object.freeze({
  catalogsByHost: {},
  cliPath: '',
  cliPathsByHost: {},
  enabled: false,
  environmentHash: '',
  environmentVariables: '',
  modelAliases: {},
  preferredReasoningByModel: {},
  sessionStoreHash: '',
  visibleModels: [],
});

/** Explicit selection order wins; an unset selection shows the catalog with its default first. */
export function getOrderedAntigravityVisibleModelIds(settings: AntigravityProviderSettings): string[] {
  if (settings.visibleModels !== null) return [...settings.visibleModels];
  const models = settings.currentCatalog?.models ?? [];
  const defaultModelId = settings.currentCatalog?.defaultModelId;
  if (!defaultModelId || !models.some(model => model.rawId === defaultModelId)) {
    return models.map(model => model.rawId);
  }
  return [defaultModelId, ...models.filter(model => model.rawId !== defaultModelId).map(model => model.rawId)];
}

export function getAntigravityMigratedVisibleModelIds(current: AntigravityProviderSettings): string[] {
  return current.visibleModels ?? [...new Set([
    ...getOrderedAntigravityVisibleModelIds(current),
    ...Object.values(current.catalogsByHost).flatMap(catalog => catalog.models.map(model => model.rawId)),
  ])];
}

export function decodeAntigravityConfig(
  config: Readonly<Record<string, unknown>>,
  selection: Pick<ProviderSelectionInputs, 'referencedModelIds'>,
): AntigravityProviderSettings {
  const catalogsByHost = normalizeCatalogsByHost(config.catalogsByHost ?? config.selectedModelsByHost);
  const currentCatalog = catalogsByHost[getInstallationKey()] ?? null;
  const visibleModels = normalizeVisibleModels(config.visibleModels);
  const allowed = collectAllowedModelIds(currentCatalog, visibleModels, selection);
  return {
    catalogsByHost,
    cliPath: readTrimmedString(config.cliPath),
    cliPathsByHost: normalizeHostnameStringMap(config.cliPathsByHost),
    currentCatalog,
    enabled: typeof config.enabled === 'boolean' ? config.enabled : DEFAULT_ANTIGRAVITY_PROVIDER_SETTINGS.enabled,
    environmentHash: readTrimmedString(config.environmentHash),
    environmentVariables: typeof config.environmentVariables === 'string' ? config.environmentVariables : '',
    modelAliases: normalizeModelStringMap(config.modelAliases, allowed),
    preferredReasoningByModel: normalizeModelStringMap(config.preferredReasoningByModel, allowed),
    sessionStoreHash: readTrimmedString(config.sessionStoreHash),
    visibleModels,
  };
}

/** Applies updates to a stored configuration in place. */
export function updateAntigravityConfig(
  config: Record<string, unknown>,
  selection: Pick<ProviderSelectionInputs, 'referencedModelIds'>,
  updates: Partial<AntigravityProviderSettings>,
): AntigravityProviderSettings {
  const current = decodeAntigravityConfig(config, selection);
  const hostKey = getInstallationKey();
  let cliPathsByHost = updates.cliPathsByHost !== undefined
    ? normalizeHostnameStringMap(updates.cliPathsByHost)
    : { ...current.cliPathsByHost };
  let cliPath = current.cliPath;
  if ('cliPath' in updates && updates.cliPathsByHost === undefined) {
    const hostCliPath = readTrimmedString(updates.cliPath);
    cliPathsByHost = { ...cliPathsByHost };
    if (hostCliPath) cliPathsByHost[hostKey] = hostCliPath;
    else delete cliPathsByHost[hostKey];
    cliPath = '';
  } else if (updates.cliPathsByHost !== undefined) {
    cliPath = readTrimmedString(updates.cliPath);
  }
  const catalogsByHost = updates.catalogsByHost !== undefined
    ? normalizeCatalogsByHost(updates.catalogsByHost)
    : { ...current.catalogsByHost };
  const currentCatalog = catalogsByHost[hostKey] ?? null;
  const visibleModels = updates.visibleModels !== undefined
    ? normalizeVisibleModels(updates.visibleModels)
    : current.visibleModels;
  const allowed = collectAllowedModelIds(currentCatalog, visibleModels, selection);
  const next: PersistedAntigravityProviderSettings = {
    catalogsByHost,
    cliPath,
    cliPathsByHost,
    enabled: updates.enabled ?? current.enabled,
    environmentHash: updates.environmentHash !== undefined
      ? readTrimmedString(updates.environmentHash)
      : current.environmentHash,
    environmentVariables: updates.environmentVariables ?? current.environmentVariables,
    modelAliases: normalizeModelStringMap(updates.modelAliases ?? current.modelAliases, allowed),
    preferredReasoningByModel: normalizeModelStringMap(
      updates.preferredReasoningByModel ?? current.preferredReasoningByModel,
      allowed,
    ),
    sessionStoreHash: updates.sessionStoreHash !== undefined
      ? readTrimmedString(updates.sessionStoreHash)
      : current.sessionStoreHash,
    visibleModels,
  };
  replaceProviderConfig(config, next as unknown as Record<string, unknown>);
  return { ...next, currentCatalog };
}

export function normalizeAntigravityCatalogSnapshot(value: unknown): AntigravityCatalogSnapshot | null {
  if (!isRecord(value)) return null;
  return {
    defaultModelId: normalizeRawModelId(value.defaultModelId),
    models: normalizeAntigravityModels(value.models),
    refreshedAt: typeof value.refreshedAt === 'number' && Number.isFinite(value.refreshedAt) && value.refreshedAt >= 0
      ? Math.floor(value.refreshedAt)
      : 0,
  };
}

function normalizeCatalogsByHost(value: unknown): Record<string, AntigravityCatalogSnapshot> {
  if (!isRecord(value)) return {};
  const catalogs: Record<string, AntigravityCatalogSnapshot> = {};
  for (const [hostKey, snapshot] of Object.entries(value)) {
    const key = hostKey.trim();
    const normalized = normalizeAntigravityCatalogSnapshot(snapshot);
    if (key && normalized) {
      Object.defineProperty(catalogs, key, { value: normalized, enumerable: true, writable: true, configurable: true });
    }
  }
  return catalogs;
}

function normalizeVisibleModels(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const ids: string[] = [];
  for (const entry of value) {
    const rawId = normalizeRawModelId(entry);
    if (rawId && !ids.includes(rawId)) ids.push(rawId);
  }
  return ids;
}

function collectAllowedModelIds(
  catalog: AntigravityCatalogSnapshot | null,
  visibleModels: readonly string[] | null,
  selection: Pick<ProviderSelectionInputs, 'referencedModelIds'>,
): Set<string> | null {
  const catalogModels = catalog?.models ?? [];
  // Without a catalog, keep stored metadata until discovery can judge it.
  if (catalogModels.length === 0) return null;
  const allowed = new Set(catalogModels.map(model => model.rawId));
  for (const id of visibleModels ?? []) allowed.add(id);
  for (const id of selection.referencedModelIds) {
    const rawId = decodeAntigravityModelId(id);
    if (rawId) allowed.add(rawId);
  }
  return allowed;
}

function normalizeModelStringMap(value: unknown, allowed: ReadonlySet<string> | null): Record<string, string> {
  if (!isRecord(value)) return {};
  const normalized: Record<string, string> = {};
  for (const [modelId, entry] of Object.entries(value)) {
    const rawId = normalizeRawModelId(modelId);
    const text = readTrimmedString(entry);
    if (!rawId || !text || (allowed && !allowed.has(rawId))) continue;
    Object.defineProperty(normalized, rawId, { value: text, enumerable: true, writable: true, configurable: true });
  }
  return normalized;
}

function normalizeRawModelId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  if (!normalized) return null;
  return decodeAntigravityModelId(normalized) ?? normalized;
}

function readTrimmedString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
