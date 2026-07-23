import { getProviderConfig, setProviderConfig } from '../../core/providers/providerConfig';
import { getProviderEnvironmentVariables } from '../../core/providers/providerEnvironment';
import type { HostnameCliPaths } from '../../core/types/settings';
import {
  getHostnameKey,
  getLegacyHostnameKey,
  migrateLegacyHostnameKeyedMap,
} from '../../utils/env';
import {
  decodeQoderModelId,
  encodeQoderModelId,
  normalizeQoderDiscoveredModels,
  type QoderDiscoveredModel,
} from './models';
import type { QoderAuthMode } from './types';

export interface PersistedQoderProviderSettings {
  authMode: QoderAuthMode;
  checkpointingEnabled: boolean;
  cliPath: string;
  cliPathsByHost: HostnameCliPaths;
  discoveredModels: QoderDiscoveredModel[];
  enabled: boolean;
  environmentHash: string;
  environmentVariables: string;
  modelAliases: Record<string, string>;
  preferredEffortByModel: Record<string, string>;
  selectedPermissionMode: string;
  visibleModels: string[];
}

export type QoderProviderSettings = PersistedQoderProviderSettings;

export const DEFAULT_QODER_PROVIDER_SETTINGS: Readonly<PersistedQoderProviderSettings> = Object.freeze({
  authMode: 'auto',
  checkpointingEnabled: true,
  cliPath: '',
  cliPathsByHost: {},
  discoveredModels: [],
  enabled: false,
  environmentHash: '',
  environmentVariables: '',
  modelAliases: {},
  preferredEffortByModel: {},
  selectedPermissionMode: 'default',
  visibleModels: [],
});

export function getQoderProviderSettings(
  settings: Record<string, unknown>,
): QoderProviderSettings {
  const config = getProviderConfig(settings, 'qoder');
  const discoveredModels = normalizeQoderDiscoveredModels(config.discoveredModels);
  const normalizedCliPathsByHost = normalizeHostnameCliPaths(config.cliPathsByHost);
  const cliPathsByHost = Object.keys(normalizedCliPathsByHost).length > 0
    ? migrateLegacyHostnameKeyedMap(
      normalizedCliPathsByHost,
      getHostnameKey(),
      getLegacyHostnameKey(),
    )
    : normalizedCliPathsByHost;

  return {
    authMode: normalizeQoderAuthMode(config.authMode),
    checkpointingEnabled: config.checkpointingEnabled !== false,
    cliPath: typeof config.cliPath === 'string'
      ? config.cliPath
      : DEFAULT_QODER_PROVIDER_SETTINGS.cliPath,
    cliPathsByHost,
    discoveredModels,
    enabled: config.enabled === true,
    environmentHash: typeof config.environmentHash === 'string'
      ? config.environmentHash
      : DEFAULT_QODER_PROVIDER_SETTINGS.environmentHash,
    environmentVariables: typeof config.environmentVariables === 'string'
      ? config.environmentVariables
      : getProviderEnvironmentVariables(settings, 'qoder'),
    modelAliases: normalizeQoderModelAliases(config.modelAliases, discoveredModels),
    preferredEffortByModel: normalizeQoderPreferredEfforts(
      config.preferredEffortByModel,
      discoveredModels,
    ),
    selectedPermissionMode: normalizeQoderPermissionMode(config.selectedPermissionMode),
    visibleModels: normalizeQoderVisibleModels(config.visibleModels, discoveredModels),
  };
}

export function updateQoderProviderSettings(
  settings: Record<string, unknown>,
  updates: Partial<QoderProviderSettings>,
): QoderProviderSettings {
  const current = getQoderProviderSettings(settings);
  const hostnameKey = getHostnameKey();
  const discoveredModels = normalizeQoderDiscoveredModels(
    updates.discoveredModels ?? current.discoveredModels,
  );
  const nextVisibleModels = normalizeQoderVisibleModels(
    updates.visibleModels ?? current.visibleModels,
    discoveredModels,
  );
  const nextCliPathsByHost = 'cliPathsByHost' in updates
    ? normalizeHostnameCliPaths(updates.cliPathsByHost)
    : { ...current.cliPathsByHost };
  let nextCliPath = 'cliPathsByHost' in updates
    ? (
      typeof updates.cliPath === 'string'
        ? updates.cliPath.trim()
        : DEFAULT_QODER_PROVIDER_SETTINGS.cliPath
    )
    : current.cliPath.trim();

  if ('cliPath' in updates && !('cliPathsByHost' in updates)) {
    const trimmedCliPath = typeof updates.cliPath === 'string' ? updates.cliPath.trim() : '';
    if (trimmedCliPath) {
      nextCliPathsByHost[hostnameKey] = trimmedCliPath;
    } else {
      delete nextCliPathsByHost[hostnameKey];
    }
    nextCliPath = DEFAULT_QODER_PROVIDER_SETTINGS.cliPath;
  }

  const next: PersistedQoderProviderSettings = {
    authMode: 'authMode' in updates
      ? normalizeQoderAuthMode(updates.authMode)
      : current.authMode,
    checkpointingEnabled: updates.checkpointingEnabled ?? current.checkpointingEnabled,
    cliPath: nextCliPath,
    cliPathsByHost: nextCliPathsByHost,
    discoveredModels,
    enabled: updates.enabled ?? current.enabled,
    environmentHash: typeof updates.environmentHash === 'string'
      ? updates.environmentHash
      : current.environmentHash,
    environmentVariables: updates.environmentVariables ?? current.environmentVariables,
    modelAliases: normalizeQoderModelAliases(
      updates.modelAliases ?? current.modelAliases,
      discoveredModels,
    ),
    preferredEffortByModel: normalizeQoderPreferredEfforts(
      updates.preferredEffortByModel ?? current.preferredEffortByModel,
      discoveredModels,
    ),
    selectedPermissionMode: 'selectedPermissionMode' in updates
      ? normalizeQoderPermissionMode(updates.selectedPermissionMode)
      : current.selectedPermissionMode,
    visibleModels: nextVisibleModels,
  };

  setProviderConfig(settings, 'qoder', next as unknown as Record<string, unknown>);
  return next;
}

export function normalizeQoderVisibleModels(
  value: unknown,
  discoveredModels: readonly QoderDiscoveredModel[] = [],
): string[] {
  if (!Array.isArray(value)) {
    return discoveredModels.filter(model => model.isDefault).map(model => encodeQoderModelId(model.rawId));
  }

  const allowed = new Set(discoveredModels.map(model => encodeQoderModelId(model.rawId)));
  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== 'string') {
      continue;
    }
    const encoded = encodeQoderModelId(decodeQoderModelId(entry) ?? entry);
    if (!encoded || seen.has(encoded)) {
      continue;
    }
    if (allowed.size > 0 && !allowed.has(encoded)) {
      continue;
    }
    seen.add(encoded);
    normalized.push(encoded);
  }
  return normalized;
}

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

function normalizeQoderAuthMode(value: unknown): QoderAuthMode {
  return value === 'qodercli' || value === 'pat-env' || value === 'auto'
    ? value
    : DEFAULT_QODER_PROVIDER_SETTINGS.authMode;
}

function normalizeQoderPermissionMode(value: unknown): string {
  const normalized = typeof value === 'string' ? value.trim() : '';
  return normalized || DEFAULT_QODER_PROVIDER_SETTINGS.selectedPermissionMode;
}

function normalizeQoderModelAliases(
  value: unknown,
  discoveredModels: readonly QoderDiscoveredModel[],
): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }

  const allowedIds = new Set(discoveredModels.map(model => model.rawId));
  const normalized: Record<string, string> = {};
  for (const [rawId, alias] of Object.entries(value as Record<string, unknown>)) {
    if (typeof alias !== 'string') {
      continue;
    }
    const normalizedRawId = decodeQoderModelId(rawId) ?? rawId.trim();
    const normalizedAlias = alias.trim();
    if (!normalizedRawId || !normalizedAlias) {
      continue;
    }
    if (allowedIds.size > 0 && !allowedIds.has(normalizedRawId)) {
      continue;
    }
    normalized[normalizedRawId] = normalizedAlias;
  }
  return normalized;
}

function normalizeQoderPreferredEfforts(
  value: unknown,
  discoveredModels: readonly QoderDiscoveredModel[],
): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }

  const supportedByModel = new Map(
    discoveredModels.map(model => [model.rawId, new Set(model.reasoningEfforts.map(effort => effort.value))] as const),
  );
  const normalized: Record<string, string> = {};
  for (const [rawId, effort] of Object.entries(value as Record<string, unknown>)) {
    if (typeof effort !== 'string') {
      continue;
    }
    const normalizedRawId = decodeQoderModelId(rawId) ?? rawId.trim();
    const normalizedEffort = effort.trim();
    if (!normalizedRawId || !normalizedEffort) {
      continue;
    }
    const supported = supportedByModel.get(normalizedRawId);
    if (supported && supported.size > 0 && !supported.has(normalizedEffort)) {
      continue;
    }
    normalized[normalizedRawId] = normalizedEffort;
  }
  return normalized;
}
