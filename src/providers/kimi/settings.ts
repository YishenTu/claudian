import { getProviderConfig, setProviderConfig } from '../../core/providers/providerConfig';
import { getProviderEnvironmentVariables } from '../../core/providers/providerEnvironment';
import type { HostnameCliPaths } from '../../core/types/settings';
import {
  getHostnameKey,
  getLegacyHostnameKey,
  migrateLegacyHostnameKeyedMap,
} from '../../utils/env';
import {
  getKimiDiscoveryState,
  seedKimiDiscoveryStateFromLegacyConfig,
  updateKimiDiscoveryState,
} from './discoveryState';
import { ensureProviderProjectionMap } from './internal/providerProjection';
import {
  decodeKimiModelId,
  encodeKimiModelId,
  isKimiModelSelectionId,
  type KimiDiscoveredModel,
  type KimiThinkingOptionsByModel,
  normalizeKimiThinkingOptionsByModel,
  resolveKimiBaseModelRawId,
  resolveKimiDefaultThinkingLevel,
} from './models';
import {
  type KimiMode,
} from './modes';

export interface PersistedKimiProviderSettings {
  cliPath: string;
  cliPathsByHost: HostnameCliPaths;
  enabled: boolean;
  environmentHash: string;
  environmentVariables: string;
  modelAliases: Record<string, string>;
  preferredThinkingByModel: Record<string, string>;
  thinkingOptionsByModel: KimiThinkingOptionsByModel;
  visibleModels: string[];
}

export interface KimiProviderSettings extends PersistedKimiProviderSettings {
  availableModes: KimiMode[];
  discoveredModels: KimiDiscoveredModel[];
}

export const DEFAULT_KIMI_PROVIDER_SETTINGS: Readonly<PersistedKimiProviderSettings> = Object.freeze({
  cliPath: '',
  cliPathsByHost: {},
  enabled: false,
  environmentHash: '',
  environmentVariables: '',
  modelAliases: {},
  preferredThinkingByModel: {},
  thinkingOptionsByModel: {},
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

export function normalizeKimiVisibleModels(
  value: unknown,
  discoveredModels: KimiDiscoveredModel[] = [],
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

    const trimmed = resolveKimiBaseModelRawId(entry.trim(), discoveredModels);
    if (!trimmed || seen.has(trimmed)) {
      continue;
    }

    seen.add(trimmed);
    normalized.push(trimmed);
  }

  return normalized;
}

export function normalizeKimiModelAliases(
  value: unknown,
  discoveredModels: KimiDiscoveredModel[] = [],
): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }

  const normalized: Record<string, string> = {};
  for (const [rawId, alias] of Object.entries(value as Record<string, unknown>)) {
    if (typeof alias !== 'string') {
      continue;
    }

    const normalizedRawId = resolveKimiBaseModelRawId(rawId.trim(), discoveredModels);
    const normalizedAlias = alias.trim();
    if (!normalizedRawId || !normalizedAlias) {
      continue;
    }

    normalized[normalizedRawId] = normalizedAlias;
  }

  return normalized;
}

export function normalizeKimiPreferredThinkingByModel(
  value: unknown,
  discoveredModels: KimiDiscoveredModel[] = [],
): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }

  const normalized: Record<string, string> = {};
  for (const [rawId, thinkingLevel] of Object.entries(value as Record<string, unknown>)) {
    if (typeof thinkingLevel !== 'string') {
      continue;
    }

    const normalizedRawId = resolveKimiBaseModelRawId(rawId.trim(), discoveredModels);
    const normalizedThinkingLevel = thinkingLevel.trim();
    if (!normalizedRawId || !normalizedThinkingLevel) {
      continue;
    }

    normalized[normalizedRawId] = normalizedThinkingLevel;
  }

  return normalized;
}

export function getKimiProviderSettings(
  settings: Record<string, unknown>,
): KimiProviderSettings {
  const config = getProviderConfig(settings, 'kimi');
  const normalizedCliPathsByHost = normalizeHostnameCliPaths(config.cliPathsByHost);
  const cliPathsByHost = Object.keys(normalizedCliPathsByHost).length > 0
    ? migrateLegacyHostnameKeyedMap(
      normalizedCliPathsByHost,
      getHostnameKey(),
      getLegacyHostnameKey(),
    )
    : normalizedCliPathsByHost;
  seedKimiDiscoveryStateFromLegacyConfig(settings, config);
  const discoveryState = getKimiDiscoveryState(settings);
  const availableModes = discoveryState.availableModes;
  const discoveredModels = discoveryState.discoveredModels;
  const persistedThinkingOptionsByModel = normalizeKimiThinkingOptionsByModel(
    config.thinkingOptionsByModel,
    discoveredModels,
  );
  const thinkingOptionsByModel = normalizeKimiThinkingOptionsByModel({
    ...persistedThinkingOptionsByModel,
    ...discoveryState.thinkingOptionsByModel,
  }, discoveredModels);

  return {
    availableModes,
    cliPath: (config.cliPath as string | undefined)
      ?? DEFAULT_KIMI_PROVIDER_SETTINGS.cliPath,
    cliPathsByHost,
    discoveredModels,
    enabled: (config.enabled as boolean | undefined)
      ?? DEFAULT_KIMI_PROVIDER_SETTINGS.enabled,
    environmentHash: (config.environmentHash as string | undefined)
      ?? DEFAULT_KIMI_PROVIDER_SETTINGS.environmentHash,
    environmentVariables: (config.environmentVariables as string | undefined)
      ?? getProviderEnvironmentVariables(settings, 'kimi')
      ?? DEFAULT_KIMI_PROVIDER_SETTINGS.environmentVariables,
    modelAliases: normalizeKimiModelAliases(config.modelAliases, discoveredModels),
    preferredThinkingByModel: normalizeKimiPreferredThinkingByModel(
      config.preferredThinkingByModel,
      discoveredModels,
    ),
    thinkingOptionsByModel,
    visibleModels: normalizeKimiVisibleModels(config.visibleModels, discoveredModels),
  };
}

export function updateKimiProviderSettings(
  settings: Record<string, unknown>,
  updates: Partial<KimiProviderSettings>,
): KimiProviderSettings {
  const current = getKimiProviderSettings(settings);
  const hostnameKey = getHostnameKey();
  if ('availableModes' in updates || 'discoveredModels' in updates || 'thinkingOptionsByModel' in updates) {
    updateKimiDiscoveryState(settings, {
      ...(updates.availableModes !== undefined ? { availableModes: updates.availableModes } : {}),
      ...(updates.discoveredModels !== undefined ? { discoveredModels: updates.discoveredModels } : {}),
      ...(updates.thinkingOptionsByModel !== undefined
        ? { thinkingOptionsByModel: updates.thinkingOptionsByModel }
        : {}),
    });
  }
  const discoveryState = getKimiDiscoveryState(settings);
  const nextAvailableModes = discoveryState.availableModes;
  const nextDiscoveredModels = discoveryState.discoveredModels;
  const nextThinkingOptionsByModel = updates.thinkingOptionsByModel !== undefined
    ? discoveryState.thinkingOptionsByModel
    : normalizeKimiThinkingOptionsByModel(
      current.thinkingOptionsByModel,
      nextDiscoveredModels,
    );
  const nextVisibleModels = normalizeKimiVisibleModels(
    updates.visibleModels ?? current.visibleModels,
    nextDiscoveredModels,
  );
  const nextModelAliases = pruneModelAliasesToVisible(
    normalizeKimiModelAliases(
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
        : DEFAULT_KIMI_PROVIDER_SETTINGS.cliPath
    )
    : current.cliPath.trim();

  if ('cliPath' in updates && !('cliPathsByHost' in updates)) {
    const trimmedCliPath = typeof updates.cliPath === 'string' ? updates.cliPath.trim() : '';
    if (trimmedCliPath) {
      nextCliPathsByHost[hostnameKey] = trimmedCliPath;
    } else {
      delete nextCliPathsByHost[hostnameKey];
    }
    nextCliPath = DEFAULT_KIMI_PROVIDER_SETTINGS.cliPath;
  }

  const next: KimiProviderSettings = {
    ...current,
    ...updates,
    availableModes: nextAvailableModes,
    cliPath: nextCliPath,
    cliPathsByHost: nextCliPathsByHost,
    discoveredModels: nextDiscoveredModels,
    modelAliases: nextModelAliases,
    preferredThinkingByModel: normalizeKimiPreferredThinkingByModel(
      updates.preferredThinkingByModel ?? current.preferredThinkingByModel,
      nextDiscoveredModels,
    ),
    thinkingOptionsByModel: nextThinkingOptionsByModel,
    visibleModels: nextVisibleModels,
  };

  if (updates.visibleModels !== undefined) {
    retargetRemovedKimiSelections(settings, next);
  }

  const persistedThinkingOptionsByModel = pruneThinkingOptionsToPersistedSelections(
    settings,
    next,
  );

  setProviderConfig(settings, 'kimi', {
    cliPath: next.cliPath,
    cliPathsByHost: next.cliPathsByHost,
    enabled: next.enabled,
    environmentHash: next.environmentHash,
    environmentVariables: next.environmentVariables,
    modelAliases: next.modelAliases,
    preferredThinkingByModel: next.preferredThinkingByModel,
    thinkingOptionsByModel: persistedThinkingOptionsByModel,
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
  settings: Record<string, unknown>,
  next: KimiProviderSettings,
): KimiThinkingOptionsByModel {
  const persistableRawIds = new Set(next.visibleModels);
  addPersistableSelection(persistableRawIds, settings.model, next.discoveredModels);
  addPersistableSelection(persistableRawIds, settings.titleGenerationModel, next.discoveredModels);

  const savedProviderModel = settings.savedProviderModel;
  if (savedProviderModel && typeof savedProviderModel === 'object' && !Array.isArray(savedProviderModel)) {
    addPersistableSelection(
      persistableRawIds,
      (savedProviderModel as Record<string, unknown>).kimi,
      next.discoveredModels,
    );
  }

  const pruned: KimiThinkingOptionsByModel = {};
  for (const rawId of persistableRawIds) {
    const options = next.thinkingOptionsByModel[rawId];
    if (options?.length) {
      pruned[rawId] = options.map((option) => ({ ...option }));
    }
  }
  return pruned;
}

function addPersistableSelection(
  target: Set<string>,
  value: unknown,
  discoveredModels: KimiDiscoveredModel[],
): void {
  if (typeof value !== 'string' || !isKimiModelSelectionId(value)) {
    return;
  }

  const rawModelId = decodeKimiModelId(value);
  if (!rawModelId) {
    return;
  }

  const baseRawId = resolveKimiBaseModelRawId(rawModelId, discoveredModels);
  if (baseRawId) {
    target.add(baseRawId);
  }
}

function retargetRemovedKimiSelections(
  settings: Record<string, unknown>,
  next: KimiProviderSettings,
): void {
  if (next.visibleModels.length === 0) {
    if (
      typeof settings.titleGenerationModel === 'string'
      && isKimiModelSelectionId(settings.titleGenerationModel)
    ) {
      settings.titleGenerationModel = '';
    }
    return;
  }

  const visibleSet = new Set(next.visibleModels);
  const fallbackRawId = next.visibleModels[0];
  const fallbackModelId = encodeKimiModelId(fallbackRawId);
  const fallbackEffort = resolveKimiDefaultThinkingLevel(
    next.thinkingOptionsByModel[fallbackRawId] ?? [],
    next.preferredThinkingByModel[fallbackRawId],
  );

  const maybeRetargetModel = (value: unknown): string | null => {
    if (typeof value !== 'string' || !isKimiModelSelectionId(value)) {
      return null;
    }

    const rawModelId = decodeKimiModelId(value);
    if (!rawModelId) {
      return fallbackModelId;
    }

    const baseRawId = resolveKimiBaseModelRawId(rawModelId, next.discoveredModels);
    return visibleSet.has(baseRawId) ? null : fallbackModelId;
  };

  const savedProviderModel = ensureProviderProjectionMap(settings, 'savedProviderModel');
  const nextSavedModel = maybeRetargetModel(savedProviderModel.kimi);
  if (nextSavedModel) {
    savedProviderModel.kimi = nextSavedModel;
    ensureProviderProjectionMap(settings, 'savedProviderEffort').kimi = fallbackEffort;
  }

  const nextTopLevelModel = maybeRetargetModel(settings.model);
  if (nextTopLevelModel) {
    settings.model = nextTopLevelModel;
    settings.effortLevel = fallbackEffort;
  }

  const nextTitleGenerationModel = maybeRetargetModel(settings.titleGenerationModel);
  if (nextTitleGenerationModel) {
    settings.titleGenerationModel = nextTitleGenerationModel;
  }
}
