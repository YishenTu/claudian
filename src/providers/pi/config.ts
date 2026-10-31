import { getInstallationKey } from '@/core/device/InstallationKey';
import { decodeInstallationSettings, DEFAULT_INSTALLATION_SETTINGS, type InstallationSettings, selectInstallationSettings, type StoredInstallationSettings,updateInstallationSettings } from '@/core/providers/settings/InstallationSettings';

import { replaceProviderConfig } from '../../core/providers/providerConfig';
import type { ProviderSelectionInputs } from '../../core/providers/ProviderRuntimeHost';
import { normalizeHostnameStringMap } from '../../core/providers/settings/HostnameStringMap';
import {
  readStoredBoolean,
  readStoredString,
} from '../../core/providers/settings/storedSettings';
import type { HostnameCLIPaths } from '../../core/types/settings';
import {
  clampPiThinkingLevel,
  decodePiModelId,
  findPiModel,
  normalizePiDiscoveredModels,
  normalizePiThinkingLevel,
  type PiDiscoveredModel,
  type PiThinkingLevel
} from './models';

interface PersistedPiProviderSettings extends StoredInstallationSettings {
  cliPath: string;
  cliPathsByHost: HostnameCLIPaths;
  discoveredModels: PiDiscoveredModel[];
  enabled: boolean;
  /** Fingerprint of every runtime input; a change restarts runtimes. */
  environmentHash: string;
  environmentVariables: string;
  modelAliases: Record<string, string>;
  preferredThinkingByModel: Record<string, PiThinkingLevel>;
  /** Fingerprint of location-affecting inputs; a change invalidates native bindings. */
  sessionEnvironmentHash: string;
  visibleModels: string[];
}

export type PiProviderSettings = PersistedPiProviderSettings & InstallationSettings;

export const DEFAULT_PI_PROVIDER_SETTINGS: Readonly<PiProviderSettings> = Object.freeze({
  ...DEFAULT_INSTALLATION_SETTINGS,
  installationMethodsByHost: {},
  wslDistroOverridesByHost: {},
  cliPath: '',
  cliPathsByHost: {},
  discoveredModels: [],
  enabled: false,
  environmentHash: '',
  environmentVariables: '',
  modelAliases: {},
  preferredThinkingByModel: {},
  sessionEnvironmentHash: '',
  visibleModels: [],
});

export function normalizePiVisibleModels(value: unknown): string[] {
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

export function decodePiConfig(
  config: Readonly<Record<string, unknown>>,
  selection: Pick<ProviderSelectionInputs, 'referencedModelIds'>,
): PiProviderSettings {
  const cliPathsByHost = normalizeHostnameStringMap(config.cliPathsByHost);
  const discoveredModels = normalizePiDiscoveredModels(config.discoveredModels ?? config.selectedModels);
  const visibleModels = normalizePiVisibleModels(config.visibleModels);
  const persistableIds = getPersistablePiModelIds(selection, visibleModels);

  const installation = decodeInstallationSettings(config);
  return {
    ...installation,
    ...selectInstallationSettings(installation, getInstallationKey()),
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
      DEFAULT_PI_PROVIDER_SETTINGS.environmentVariables,
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
    sessionEnvironmentHash: readStoredString(
      config.sessionEnvironmentHash,
      DEFAULT_PI_PROVIDER_SETTINGS.sessionEnvironmentHash,
    ),
    visibleModels,
  };
}

/** Applies updates to a stored Pi configuration in place, normalizing against the current selections. */
export function updatePiConfig(
  config: Record<string, unknown>,
  selection: Pick<ProviderSelectionInputs, 'referencedModelIds'>,
  updates: Partial<PiProviderSettings>,
): PiProviderSettings {
  const current = decodePiConfig(config, selection);
  const hostnameKey = getInstallationKey();
  const nextDiscoveredModels = normalizePiDiscoveredModels(updates.discoveredModels ?? current.discoveredModels,);
  const nextVisibleModels = normalizePiVisibleModels(updates.visibleModels ?? current.visibleModels);
  const persistableIds = getPersistablePiModelIds(selection, nextVisibleModels);
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
    ...updateInstallationSettings(current, updates, hostnameKey),
    cliPath: nextCliPath,
    cliPathsByHost: nextCliPathsByHost,
    discoveredModels: nextDiscoveredModels,
    modelAliases: nextModelAliases,
    preferredThinkingByModel: nextPreferredThinkingByModel,
    visibleModels: nextVisibleModels,
  };

  replaceProviderConfig(config, {
    installationMethodsByHost: next.installationMethodsByHost,
    wslDistroOverridesByHost: next.wslDistroOverridesByHost,
    cliPath: next.cliPath,
    cliPathsByHost: next.cliPathsByHost,
    discoveredModels: next.discoveredModels,
    enabled: next.enabled,
    environmentHash: next.environmentHash,
    environmentVariables: next.environmentVariables,
    modelAliases: next.modelAliases,
    preferredThinkingByModel: next.preferredThinkingByModel,
    sessionEnvironmentHash: next.sessionEnvironmentHash,
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
  selection: Pick<ProviderSelectionInputs, 'referencedModelIds'>,
  visibleModels: string[],
): Set<string> {
  const persistableIds = new Set(visibleModels);
  for (const id of selection.referencedModelIds) {
    if (decodePiModelId(id)) persistableIds.add(id);
  }
  return persistableIds;
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
