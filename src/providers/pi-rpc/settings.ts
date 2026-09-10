import { getProviderConfig, setProviderConfig } from '../../core/providers/providerConfig';
import { getProviderEnvironmentVariables } from '../../core/providers/providerEnvironment';
import { normalizeHostnameStringMap } from '../../core/providers/settings/HostnameStringMap';
import {
  readStoredBoolean,
  readStoredString,
} from '../../core/providers/settings/storedSettings';
import type { HostnameCliPaths } from '../../core/types/settings';
import { getHostnameKey } from '../../utils/env';
import { ensureProviderProjectionMap } from './internal/providerProjection';
import type {
  PiDiscoveredModel,
  PiFamilyModelContract,
  PiThinkingLevel,
} from './models';

export type PiToolMode = 'all' | 'readonly';

export interface PersistedPiProviderSettings {
  cliPath: string;
  cliPathsByHost: HostnameCliPaths;
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

export const DEFAULT_PI_FAMILY_PROVIDER_SETTINGS: Readonly<PersistedPiProviderSettings> = Object.freeze({
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

export interface PiFamilySettingsAccess {
  readonly defaults: Readonly<PersistedPiProviderSettings>;
  get: (settings: Record<string, unknown>) => PiProviderSettings;
  update: (
    settings: Record<string, unknown>,
    updates: Partial<PiProviderSettings>,
  ) => PiProviderSettings;
  normalizeVisibleModels: (value: unknown, discoveredModels?: PiDiscoveredModel[]) => string[];
  normalizeModelAliases: (
    value: unknown,
    discoveredModels?: PiDiscoveredModel[],
  ) => Record<string, string>;
  normalizePreferredThinkingByModel: (
    value: unknown,
    discoveredModels?: PiDiscoveredModel[],
  ) => Record<string, PiThinkingLevel>;
  resolveModelAlias: (settings: PiProviderSettings, encodedId: string) => string | null;
}

export function definePiFamilySettings(
  providerId: string,
  models: PiFamilyModelContract,
): PiFamilySettingsAccess {
  const normalizeVisibleModels = (
    value: unknown,
    discoveredModels: PiDiscoveredModel[] = [],
  ): string[] => {
    if (!Array.isArray(value)) {
      return [];
    }

    const knownIds = new Set(discoveredModels.map(model => model.encodedId));
    const normalized: string[] = [];
    const seen = new Set<string>();
    for (const entry of value) {
      if (typeof entry !== 'string') {
        continue;
      }

      const trimmed = entry.trim();
      if (!trimmed || !models.decodeModelId(trimmed)) {
        continue;
      }
      if (knownIds.size > 0 && !knownIds.has(trimmed)) {
        continue;
      }
      if (seen.has(trimmed)) {
        continue;
      }

      seen.add(trimmed);
      normalized.push(trimmed);
    }

    return normalized;
  };

  const normalizeEncodedId = (
    value: string,
    discoveredModels: PiDiscoveredModel[],
  ): string => {
    const trimmed = value.trim();
    const decoded = models.decodeModelId(trimmed);
    if (!decoded) {
      return '';
    }

    if (discoveredModels.length === 0) {
      return trimmed;
    }

    const discoveredModel = models.findModel({ discoveredModels }, trimmed);
    return discoveredModel ? discoveredModel.encodedId : '';
  };

  const normalizeModelAliases = (
    value: unknown,
    discoveredModels: PiDiscoveredModel[] = [],
  ): Record<string, string> => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return {};
    }

    const normalized: Record<string, string> = {};
    for (const [encodedId, alias] of Object.entries(value as Record<string, unknown>)) {
      if (typeof alias !== 'string') {
        continue;
      }

      const normalizedEncodedId = normalizeEncodedId(encodedId, discoveredModels);
      const normalizedAlias = alias.trim();
      if (!normalizedEncodedId || !normalizedAlias) {
        continue;
      }

      normalized[normalizedEncodedId] = normalizedAlias;
    }

    return normalized;
  };

  const normalizePreferredThinkingEntries = (
    value: unknown,
    discoveredModels: PiDiscoveredModel[],
    normalizeId: (encodedId: string) => string,
  ): Record<string, PiThinkingLevel> => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return {};
    }

    const normalized: Record<string, PiThinkingLevel> = {};
    for (const [encodedId, thinkingLevel] of Object.entries(value as Record<string, unknown>)) {
      const normalizedEncodedId = normalizeId(encodedId);
      const normalizedThinkingLevel = models.normalizeThinkingLevel(thinkingLevel);
      if (!normalizedEncodedId || !normalizedThinkingLevel) {
        continue;
      }

      const discoveredModel = discoveredModels.find(model => model.encodedId === normalizedEncodedId);
      normalized[normalizedEncodedId] = discoveredModel
        ? models.clampThinkingLevel(normalizedThinkingLevel, discoveredModel.thinkingLevels)
        : normalizedThinkingLevel;
    }

    return normalized;
  };

  const normalizePreferredThinkingByModel = (
    value: unknown,
    discoveredModels: PiDiscoveredModel[] = [],
  ): Record<string, PiThinkingLevel> => {
    return normalizePreferredThinkingEntries(
      value,
      discoveredModels,
      encodedId => normalizeEncodedId(encodedId, discoveredModels),
    );
  };

  const normalizePersistableEncodedId = (
    value: string,
    discoveredModels: PiDiscoveredModel[],
    persistableIds: Set<string>,
  ): string => {
    const trimmed = value.trim();
    const decoded = models.decodeModelId(trimmed);
    if (!decoded) {
      return '';
    }

    const discoveredModel = models.findModel({ discoveredModels }, trimmed);
    if (discoveredModel) {
      return discoveredModel.encodedId;
    }

    return persistableIds.has(trimmed) ? trimmed : '';
  };

  const normalizeModelAliasesForPersistableIds = (
    value: unknown,
    discoveredModels: PiDiscoveredModel[],
    persistableIds: Set<string>,
  ): Record<string, string> => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return {};
    }

    const normalized: Record<string, string> = {};
    for (const [encodedId, alias] of Object.entries(value as Record<string, unknown>)) {
      if (typeof alias !== 'string') {
        continue;
      }

      const normalizedEncodedId = normalizePersistableEncodedId(
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
  };

  const normalizePreferredThinkingForPersistableIds = (
    value: unknown,
    discoveredModels: PiDiscoveredModel[],
    persistableIds: Set<string>,
  ): Record<string, PiThinkingLevel> => {
    return normalizePreferredThinkingEntries(
      value,
      discoveredModels,
      encodedId => normalizePersistableEncodedId(encodedId, discoveredModels, persistableIds),
    );
  };

  const addPersistableSelection = (target: Set<string>, value: unknown): void => {
    if (typeof value === 'string' && models.decodeModelId(value)) {
      target.add(value);
    }
  };

  const getPersistableModelIds = (
    settings: Record<string, unknown>,
    visibleModels: string[],
  ): Set<string> => {
    const persistableIds = new Set(visibleModels);
    addPersistableSelection(persistableIds, settings.model);
    addPersistableSelection(persistableIds, settings.titleGenerationModel);

    const savedProviderModel = settings.savedProviderModel;
    if (savedProviderModel && typeof savedProviderModel === 'object' && !Array.isArray(savedProviderModel)) {
      addPersistableSelection(persistableIds, (savedProviderModel as Record<string, unknown>)[providerId]);
    }

    return persistableIds;
  };

  const pruneMapToPersistableIds = <T extends string>(
    value: Record<string, T>,
    persistableIds: Set<string>,
  ): Record<string, T> => {
    const pruned: Record<string, T> = {};
    for (const [encodedId, entry] of Object.entries(value)) {
      if (persistableIds.has(encodedId)) {
        pruned[encodedId] = entry;
      }
    }
    return pruned;
  };

  const normalizeToolMode = (value: unknown): PiToolMode => {
    if (value === undefined) {
      return 'all';
    }
    return value === 'all' || value === 'readonly' ? value : 'readonly';
  };

  const retargetRemovedSelections = (
    settings: Record<string, unknown>,
    next: PiProviderSettings,
  ): void => {
    if (next.visibleModels.length === 0) {
      if (typeof settings.titleGenerationModel === 'string' && models.isModelSelectionId(settings.titleGenerationModel)) {
        settings.titleGenerationModel = '';
      }
      return;
    }

    const visibleSet = new Set(next.visibleModels);
    const fallbackModelId = next.visibleModels[0];
    const fallbackModel = models.findModel(next, fallbackModelId);
    const fallbackEffort = next.preferredThinkingByModel[fallbackModelId]
      ?? (fallbackModel
        ? models.clampThinkingLevel(models.defaultThinkingLevel, fallbackModel.thinkingLevels)
        : models.defaultThinkingLevel);

    const maybeRetargetModel = (value: unknown): string | null => {
      if (typeof value !== 'string' || !models.isModelSelectionId(value)) {
        return null;
      }

      return visibleSet.has(value) ? null : fallbackModelId;
    };

    const savedProviderModel = ensureProviderProjectionMap(settings, 'savedProviderModel');
    const nextSavedModel = maybeRetargetModel(savedProviderModel[providerId]);
    if (nextSavedModel) {
      savedProviderModel[providerId] = nextSavedModel;
      ensureProviderProjectionMap(settings, 'savedProviderEffort')[providerId] = fallbackEffort;
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
  };

  const get = (settings: Record<string, unknown>): PiProviderSettings => {
    const config = getProviderConfig(settings, providerId);
    const cliPathsByHost = normalizeHostnameStringMap(config.cliPathsByHost);
    const discoveredModels = models.normalizeDiscoveredModels(config.discoveredModels);
    const visibleModels = normalizeVisibleModels(config.visibleModels, discoveredModels);
    const persistableIds = getPersistableModelIds(settings, visibleModels);

    return {
      cliPath: readStoredString(config.cliPath, DEFAULT_PI_FAMILY_PROVIDER_SETTINGS.cliPath),
      cliPathsByHost,
      discoveredModels,
      enabled: readStoredBoolean(config.enabled, DEFAULT_PI_FAMILY_PROVIDER_SETTINGS.enabled),
      environmentHash: readStoredString(
        config.environmentHash,
        DEFAULT_PI_FAMILY_PROVIDER_SETTINGS.environmentHash,
      ),
      environmentVariables: readStoredString(
        config.environmentVariables,
        getProviderEnvironmentVariables(settings, providerId)
          ?? DEFAULT_PI_FAMILY_PROVIDER_SETTINGS.environmentVariables,
      ),
      modelAliases: normalizeModelAliasesForPersistableIds(
        config.modelAliases,
        discoveredModels,
        persistableIds,
      ),
      preferredThinkingByModel: normalizePreferredThinkingForPersistableIds(
        config.preferredThinkingByModel,
        discoveredModels,
        persistableIds,
      ),
      toolMode: normalizeToolMode(config.toolMode),
      visibleModels,
    };
  };

  const update = (
    settings: Record<string, unknown>,
    updates: Partial<PiProviderSettings>,
  ): PiProviderSettings => {
    const current = get(settings);
    const hostnameKey = getHostnameKey();
    const nextDiscoveredModels = models.normalizeDiscoveredModels(
      updates.discoveredModels ?? current.discoveredModels,
    );
    const nextVisibleModels = normalizeVisibleModels(
      updates.visibleModels ?? current.visibleModels,
      nextDiscoveredModels,
    );
    const persistableIds = getPersistableModelIds(settings, nextVisibleModels);
    const nextModelAliases = pruneMapToPersistableIds(
      normalizeModelAliasesForPersistableIds(
        updates.modelAliases ?? current.modelAliases,
        nextDiscoveredModels,
        persistableIds,
      ),
      persistableIds,
    );
    const nextPreferredThinkingByModel = pruneMapToPersistableIds(
      normalizePreferredThinkingForPersistableIds(
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
          : DEFAULT_PI_FAMILY_PROVIDER_SETTINGS.cliPath
      )
      : current.cliPath.trim();

    if ('cliPath' in updates && !('cliPathsByHost' in updates)) {
      const trimmedCliPath = typeof updates.cliPath === 'string' ? updates.cliPath.trim() : '';
      if (trimmedCliPath) {
        nextCliPathsByHost[hostnameKey] = trimmedCliPath;
      } else {
        delete nextCliPathsByHost[hostnameKey];
      }
      nextCliPath = DEFAULT_PI_FAMILY_PROVIDER_SETTINGS.cliPath;
    }

    const next: PiProviderSettings = {
      ...current,
      ...updates,
      cliPath: nextCliPath,
      cliPathsByHost: nextCliPathsByHost,
      discoveredModels: nextDiscoveredModels,
      modelAliases: nextModelAliases,
      preferredThinkingByModel: nextPreferredThinkingByModel,
      toolMode: normalizeToolMode(updates.toolMode ?? current.toolMode),
      visibleModels: nextVisibleModels,
    };

    if (updates.visibleModels !== undefined) {
      retargetRemovedSelections(settings, next);
      const retargetedPersistableIds = getPersistableModelIds(settings, next.visibleModels);
      next.modelAliases = pruneMapToPersistableIds(next.modelAliases, retargetedPersistableIds);
      next.preferredThinkingByModel = pruneMapToPersistableIds(
        next.preferredThinkingByModel,
        retargetedPersistableIds,
      );
    }

    setProviderConfig(settings, providerId, {
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
  };

  const resolveModelAlias = (settings: PiProviderSettings, encodedId: string): string | null => {
    return settings.modelAliases[encodedId] ?? null;
  };

  return {
    defaults: DEFAULT_PI_FAMILY_PROVIDER_SETTINGS,
    get,
    update,
    normalizeVisibleModels,
    normalizeModelAliases,
    normalizePreferredThinkingByModel,
    resolveModelAlias,
  };
}
