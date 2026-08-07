import { getProviderConfig, setProviderConfig } from '../../core/providers/providerConfig';
import { getProviderEnvironmentVariables } from '../../core/providers/providerEnvironment';
import { DEFAULT_REASONING_VALUE } from '../../core/providers/reasoning';
import { normalizeHostnameStringMap } from '../../core/providers/settings/HostnameStringMap';
import {
  readStoredBoolean,
  readStoredString,
} from '../../core/providers/settings/storedSettings';
import type { HostnameCliPaths } from '../../core/types/settings';
import { getHostnameKey } from '../../utils/env';
import {
  type CodexDiscoveredModel,
  findCodexModel,
  getCodexDefaultReasoningEffort,
  getDefaultCodexModel,
  isCodexModelAvailable,
  normalizeCodexDiscoveredModels,
} from './models';
import { toCodexRuntimeModelId } from './modelSelection';
import { CODEX_SPARK_MODEL } from './types/models';

export type CodexSafeMode = 'workspace-write' | 'read-only';
export type CodexReasoningSummary = 'auto' | 'concise' | 'detailed' | 'none';
export type CodexInstallationMethod = 'native-windows' | 'wsl';
export type HostnameInstallationMethods = Record<string, CodexInstallationMethod>;

const CODEX_SAFE_MODES = ['workspace-write', 'read-only'] as const;
const CODEX_REASONING_SUMMARIES = ['auto', 'concise', 'detailed', 'none'] as const;

export interface CodexProviderConfig {
  enabled: boolean;
  safeMode: CodexSafeMode;
  cliPath: string;
  cliPathsByHost: HostnameCliPaths;
  customModels: string;
  discoveredModels: CodexDiscoveredModel[];
  modelAliases: Record<string, string>;
  visibleModels: string[] | null;
  enableUltraEffort: boolean;
  reasoningSummary: CodexReasoningSummary;
  environmentVariables: string;
  environmentHash: string;
  catalogTimestamp: number;
  catalogFingerprint: string;
  installationMethodsByHost: HostnameInstallationMethods;
  wslDistroOverridesByHost: HostnameCliPaths;
}

export interface NormalizeCodexStoredConfigContext {
  platform?: NodeJS.Platform;
  hostnameKey?: string;
}

export interface NormalizeCodexStoredConfigResult {
  config: CodexProviderConfig & Record<string, unknown>;
  changed: boolean;
}

function normalizeCodexInstallationMethod(value: unknown): CodexInstallationMethod {
  return value === 'wsl' ? 'wsl' : 'native-windows';
}

function normalizeOptionalString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function readStoredCodexSafeMode(
  value: unknown,
  fallback: CodexSafeMode,
): CodexSafeMode {
  if (value === undefined) {
    return fallback;
  }
  return (CODEX_SAFE_MODES as readonly unknown[]).includes(value)
    ? value as CodexSafeMode
    : 'read-only';
}

function readStoredCodexReasoningSummary(
  value: unknown,
  fallback: CodexReasoningSummary,
): CodexReasoningSummary {
  return (CODEX_REASONING_SUMMARIES as readonly unknown[]).includes(value)
    ? value as CodexReasoningSummary
    : fallback;
}

function shouldPersistCodexInstallationSettings(): boolean {
  return process.platform === 'win32';
}

function omitCurrentHost<T>(entries: Record<string, T>, hostnameKey: string): Record<string, T> {
  const next = { ...entries };
  delete next[hostnameKey];
  return next;
}

type CodexProjectionKey =
  | 'savedProviderEffort'
  | 'savedProviderModel'
  | 'savedProviderServiceTier';

function ensureCodexProjectionMap(
  settings: Record<string, unknown>,
  key: CodexProjectionKey,
): Record<string, string> {
  const current = settings[key];
  if (current && typeof current === 'object' && !Array.isArray(current)) {
    return current as Record<string, string>;
  }

  const next: Record<string, string> = {};
  settings[key] = next;
  return next;
}

export interface CodexProviderSettings {
  enabled: CodexProviderConfig['enabled'];
  safeMode: CodexProviderConfig['safeMode'];
  cliPath: CodexProviderConfig['cliPath'];
  cliPathsByHost: CodexProviderConfig['cliPathsByHost'];
  customModels: CodexProviderConfig['customModels'];
  discoveredModels: CodexProviderConfig['discoveredModels'];
  modelAliases: CodexProviderConfig['modelAliases'];
  visibleModels: CodexProviderConfig['visibleModels'];
  enableUltraEffort: CodexProviderConfig['enableUltraEffort'];
  reasoningSummary: CodexProviderConfig['reasoningSummary'];
  environmentVariables: CodexProviderConfig['environmentVariables'];
  environmentHash: CodexProviderConfig['environmentHash'];
  catalogTimestamp: CodexProviderConfig['catalogTimestamp'];
  catalogFingerprint: CodexProviderConfig['catalogFingerprint'];
  installationMethod: CodexInstallationMethod;
  installationMethodsByHost: CodexProviderConfig['installationMethodsByHost'];
  wslDistroOverride: string;
  wslDistroOverridesByHost: CodexProviderConfig['wslDistroOverridesByHost'];
}

export const DEFAULT_CODEX_PROVIDER_CONFIG: Readonly<CodexProviderConfig> = Object.freeze({
  enabled: false,
  safeMode: 'workspace-write',
  cliPath: '',
  cliPathsByHost: {},
  customModels: '',
  discoveredModels: [],
  modelAliases: {},
  visibleModels: null,
  enableUltraEffort: false,
  reasoningSummary: 'detailed',
  environmentVariables: '',
  environmentHash: '',
  catalogTimestamp: 0,
  catalogFingerprint: '',
  installationMethodsByHost: {},
  wslDistroOverridesByHost: {},
});

export const DEFAULT_CODEX_PROVIDER_SETTINGS: Readonly<CodexProviderSettings> = Object.freeze({
  ...DEFAULT_CODEX_PROVIDER_CONFIG,
  installationMethod: 'native-windows',
  wslDistroOverride: '',
});

export function shouldDisableCodexReasoningSummary(model: string | undefined): boolean {
  return model ? toCodexRuntimeModelId(model) === CODEX_SPARK_MODEL : false;
}

export function getEffectiveCodexReasoningSummary(
  settings: Record<string, unknown>,
  model: string | undefined,
): CodexReasoningSummary {
  if (shouldDisableCodexReasoningSummary(model)) {
    return 'none';
  }

  return getCodexProviderSettings(settings).reasoningSummary;
}

export function applyCodexModelDefaults(
  model: string,
  settings: Record<string, unknown>,
): void {
  const codexSettings = getCodexProviderSettings(settings);
  const modelMetadata = findCodexModel(codexSettings.discoveredModels, model);
  settings.effortLevel = modelMetadata
    ? getCodexDefaultReasoningEffort(modelMetadata, codexSettings.enableUltraEffort)
      ?? DEFAULT_REASONING_VALUE
    : DEFAULT_REASONING_VALUE;
  if (shouldDisableCodexReasoningSummary(model)) {
    updateCodexProviderSettings(settings, { reasoningSummary: 'none' });
  }
}

export function normalizeCodexVisibleModels(
  value: unknown,
  discoveredModels: CodexDiscoveredModel[] = [],
): string[] | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (!Array.isArray(value)) {
    return null;
  }

  const knownModelIds = new Set(discoveredModels.map(model => model.model));
  const visibleModels: string[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== 'string') {
      continue;
    }

    const modelId = entry.trim();
    if (
      !modelId
      || seen.has(modelId)
      || (knownModelIds.size > 0 && !knownModelIds.has(modelId))
    ) {
      continue;
    }

    seen.add(modelId);
    visibleModels.push(modelId);
  }

  return visibleModels;
}

export function normalizeCodexModelAliases(
  value: unknown,
  discoveredModels: CodexDiscoveredModel[] = [],
): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }

  const knownModelIds = new Set(discoveredModels.map(model => model.model));
  const normalized: Record<string, string> = {};
  for (const [rawModelId, rawAlias] of Object.entries(value as Record<string, unknown>)) {
    if (typeof rawAlias !== 'string') {
      continue;
    }

    const modelId = rawModelId.trim();
    const alias = rawAlias.trim();
    if (!modelId || !alias || (knownModelIds.size > 0 && !knownModelIds.has(modelId))) {
      continue;
    }
    normalized[modelId] = alias;
  }
  return normalized;
}

export function createCodexVisibleModelFilter(
  value: unknown,
  discoveredModels: CodexDiscoveredModel[],
): string[] | null {
  return normalizeCodexVisibleModels(value, discoveredModels);
}

export function getVisibleCodexModelIds(
  visibleModels: string[] | null,
  discoveredModels: CodexDiscoveredModel[],
): string[] {
  if (visibleModels !== null) {
    return normalizeCodexVisibleModels(visibleModels, discoveredModels) ?? [];
  }

  const defaultModel = getDefaultCodexModel(discoveredModels);
  return defaultModel
    ? [
      defaultModel.model,
      ...discoveredModels
        .filter(model => model.model !== defaultModel.model)
        .map(model => model.model),
    ]
    : [];
}

function pruneCodexModelAliases(
  aliases: Record<string, string>,
  visibleModelIds: string[] | null,
): Record<string, string> {
  if (visibleModelIds === null) {
    return aliases;
  }

  const visible = new Set(visibleModelIds);
  return Object.fromEntries(
    Object.entries(aliases).filter(([modelId]) => visible.has(modelId)),
  );
}

function getCodexAliasModelIds(
  visibleModels: string[] | null,
  discoveredModels: CodexDiscoveredModel[],
): string[] | null {
  if (discoveredModels.length === 0 && visibleModels === null) {
    return null;
  }
  return getVisibleCodexModelIds(visibleModels, discoveredModels);
}

function retargetRemovedCodexSelections(
  settings: Record<string, unknown>,
  next: CodexProviderSettings,
): void {
  if (next.visibleModels === null) {
    return;
  }

  const visibleModelIds = new Set(next.visibleModels);
  if (visibleModelIds.size === 0) {
    if (findCodexModel(next.discoveredModels, settings.titleGenerationModel as string | undefined)) {
      settings.titleGenerationModel = '';
    }
    return;
  }

  const fallbackModel = next.visibleModels
    .map(modelId => next.discoveredModels.find(model => model.model === modelId))
    .find((model): model is CodexDiscoveredModel => Boolean(
      model && isCodexModelAvailable(model, next.enableUltraEffort),
    )) ?? null;
  if (!fallbackModel) {
    return;
  }

  const maybeRetarget = (value: unknown): string | null => {
    if (typeof value !== 'string') {
      return null;
    }

    const model = findCodexModel(next.discoveredModels, value);
    return model && !visibleModelIds.has(model.model) ? fallbackModel.model : null;
  };
  const fallbackServiceTier = fallbackModel.defaultServiceTier ?? 'default';

  const existingSavedModels = settings.savedProviderModel;
  const savedCodexModel = existingSavedModels
    && typeof existingSavedModels === 'object'
    && !Array.isArray(existingSavedModels)
    ? (existingSavedModels as Record<string, unknown>).codex
    : undefined;
  const nextSavedModel = maybeRetarget(savedCodexModel);
  if (nextSavedModel) {
    ensureCodexProjectionMap(settings, 'savedProviderModel').codex = nextSavedModel;
    ensureCodexProjectionMap(settings, 'savedProviderEffort').codex = getCodexDefaultReasoningEffort(
      fallbackModel,
      next.enableUltraEffort,
    ) ?? DEFAULT_REASONING_VALUE;
    ensureCodexProjectionMap(settings, 'savedProviderServiceTier').codex = fallbackServiceTier;
  }

  const nextTopLevelModel = maybeRetarget(settings.model);
  if (nextTopLevelModel) {
    settings.model = nextTopLevelModel;
    settings.effortLevel = getCodexDefaultReasoningEffort(
      fallbackModel,
      next.enableUltraEffort,
    ) ?? DEFAULT_REASONING_VALUE;
    settings.serviceTier = fallbackServiceTier;
  }

  const nextTitleGenerationModel = maybeRetarget(settings.titleGenerationModel);
  if (nextTitleGenerationModel) {
    settings.titleGenerationModel = nextTitleGenerationModel;
  }
}

function normalizeInstallationMethodsByHost(value: unknown): HostnameInstallationMethods {
  const normalized = normalizeHostnameStringMap(value);
  const result: HostnameInstallationMethods = {};
  for (const [key, entry] of Object.entries(normalized)) {
    Object.defineProperty(result, key, {
      configurable: true,
      enumerable: true,
      value: normalizeCodexInstallationMethod(entry),
      writable: true,
    });
  }
  return result;
}

function hasOwnEntry<T>(entries: Record<string, T>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(entries, key);
}

function getCodexStoredConfig(
  settings: Record<string, unknown>,
): CodexProviderConfig {
  const config = getProviderConfig(settings, 'codex');
  const cliPathsByHost = normalizeHostnameStringMap(
    config.cliPathsByHost ?? settings.codexCliPathsByHost,
  );
  const installationMethodsByHost = normalizeInstallationMethodsByHost(
    config.installationMethodsByHost,
  );
  const wslDistroOverridesByHost = normalizeHostnameStringMap(
    config.wslDistroOverridesByHost,
  );
  const discoveredModels = normalizeCodexDiscoveredModels(config.discoveredModels);
  const visibleModels = normalizeCodexVisibleModels(config.visibleModels, discoveredModels);

  return {
    enabled: readStoredBoolean(
      config.enabled,
      readStoredBoolean(settings.codexEnabled, DEFAULT_CODEX_PROVIDER_CONFIG.enabled),
    ),
    safeMode: readStoredCodexSafeMode(
      config.safeMode,
      readStoredCodexSafeMode(settings.codexSafeMode, DEFAULT_CODEX_PROVIDER_CONFIG.safeMode),
    ),
    cliPath: readStoredString(
      config.cliPath,
      readStoredString(settings.codexCliPath, DEFAULT_CODEX_PROVIDER_CONFIG.cliPath),
    ),
    cliPathsByHost,
    customModels: readStoredString(config.customModels, DEFAULT_CODEX_PROVIDER_CONFIG.customModels),
    discoveredModels,
    modelAliases: pruneCodexModelAliases(
      normalizeCodexModelAliases(config.modelAliases, discoveredModels),
      getCodexAliasModelIds(visibleModels, discoveredModels),
    ),
    visibleModels,
    enableUltraEffort: config.enableUltraEffort === true,
    reasoningSummary: readStoredCodexReasoningSummary(
      config.reasoningSummary,
      readStoredCodexReasoningSummary(
        settings.codexReasoningSummary,
        DEFAULT_CODEX_PROVIDER_CONFIG.reasoningSummary,
      ),
    ),
    environmentVariables: readStoredString(
      config.environmentVariables,
      getProviderEnvironmentVariables(settings, 'codex')
        ?? DEFAULT_CODEX_PROVIDER_CONFIG.environmentVariables,
    ),
    environmentHash: readStoredString(
      config.environmentHash,
      readStoredString(settings.lastCodexEnvHash, DEFAULT_CODEX_PROVIDER_CONFIG.environmentHash),
    ),
    catalogTimestamp: typeof config.catalogTimestamp === 'number'
      && Number.isFinite(config.catalogTimestamp)
      && config.catalogTimestamp >= 0
      ? config.catalogTimestamp
      : DEFAULT_CODEX_PROVIDER_CONFIG.catalogTimestamp,
    catalogFingerprint: readStoredString(
      config.catalogFingerprint,
      DEFAULT_CODEX_PROVIDER_CONFIG.catalogFingerprint,
    ),
    installationMethodsByHost,
    wslDistroOverridesByHost,
  };
}

function getNormalizedCodexStoredConfigContext(
  context: NormalizeCodexStoredConfigContext,
): Required<NormalizeCodexStoredConfigContext> {
  return {
    platform: context.platform ?? process.platform,
    hostnameKey: context.hostnameKey ?? getHostnameKey(),
  };
}

function projectStoredCodexConfigNormalization(
  originalConfig: Record<string, unknown>,
  normalizedConfig: Record<string, unknown>,
): Record<string, unknown> {
  const projected = { ...originalConfig };
  for (const key of Object.keys(DEFAULT_CODEX_PROVIDER_CONFIG)) {
    if (key in originalConfig) {
      projected[key] = normalizedConfig[key];
    }
  }
  delete projected.installationMethod;
  delete projected.wslDistroOverride;
  return projected;
}

export function normalizeCodexStoredConfig(
  settings: Record<string, unknown>,
  context: NormalizeCodexStoredConfigContext = {},
): NormalizeCodexStoredConfigResult {
  const originalConfig = getProviderConfig(settings, 'codex');
  const {
    platform,
    hostnameKey,
  } = getNormalizedCodexStoredConfigContext(context);
  const storedConfig = getCodexStoredConfig(settings);
  const installationMethodsByHost = { ...storedConfig.installationMethodsByHost };
  const wslDistroOverridesByHost = { ...storedConfig.wslDistroOverridesByHost };

  if (platform === 'win32') {
    if (!hasOwnEntry(installationMethodsByHost, hostnameKey) && 'installationMethod' in originalConfig) {
      installationMethodsByHost[hostnameKey] = normalizeCodexInstallationMethod(originalConfig.installationMethod);
    }

    if (!hasOwnEntry(wslDistroOverridesByHost, hostnameKey) && 'wslDistroOverride' in originalConfig) {
      const normalizedDistroOverride = normalizeOptionalString(originalConfig.wslDistroOverride);
      if (normalizedDistroOverride) {
        wslDistroOverridesByHost[hostnameKey] = normalizedDistroOverride;
      }
    }
  } else {
    delete installationMethodsByHost[hostnameKey];
    delete wslDistroOverridesByHost[hostnameKey];
  }

  const normalizedConfig: CodexProviderConfig & Record<string, unknown> = {
    ...originalConfig,
    ...storedConfig,
    installationMethodsByHost,
    wslDistroOverridesByHost,
  };
  delete normalizedConfig.installationMethod;
  delete normalizedConfig.wslDistroOverride;

  const projectedConfig = projectStoredCodexConfigNormalization(originalConfig, normalizedConfig);
  return {
    config: normalizedConfig,
    changed: JSON.stringify(projectedConfig) !== JSON.stringify(originalConfig),
  };
}

export function getCodexProviderSettings(
  settings: Record<string, unknown>,
): CodexProviderSettings {
  const config = getProviderConfig(settings, 'codex');
  const hostnameKey = getHostnameKey();
  const storedConfig = getCodexStoredConfig(settings);
  const hasHostScopedInstallationMethods = Object.keys(storedConfig.installationMethodsByHost).length > 0;
  const hasHostScopedWslDistroOverrides = Object.keys(storedConfig.wslDistroOverridesByHost).length > 0;
  const legacyInstallationMethod = normalizeCodexInstallationMethod(config.installationMethod);
  const legacyWslDistroOverride = normalizeOptionalString(config.wslDistroOverride);

  return {
    ...storedConfig,
    installationMethod: storedConfig.installationMethodsByHost[hostnameKey]
      ?? (
        hasHostScopedInstallationMethods
          ? DEFAULT_CODEX_PROVIDER_SETTINGS.installationMethod
          : legacyInstallationMethod
      ),
    wslDistroOverride: storedConfig.wslDistroOverridesByHost[hostnameKey]
      ?? (
        hasHostScopedWslDistroOverrides
          ? DEFAULT_CODEX_PROVIDER_SETTINGS.wslDistroOverride
          : legacyWslDistroOverride
      ),
  };
}

export function updateCodexProviderSettings(
  settings: Record<string, unknown>,
  updates: Partial<CodexProviderSettings>,
): CodexProviderSettings {
  const current = getCodexProviderSettings(settings);
  const hostnameKey = getHostnameKey();
  const persistInstallationSettings = shouldPersistCodexInstallationSettings();
  const updatedInstallationMethodsByHost = 'installationMethodsByHost' in updates
    ? normalizeInstallationMethodsByHost(updates.installationMethodsByHost)
    : { ...current.installationMethodsByHost };
  const updatedWslDistroOverridesByHost = 'wslDistroOverridesByHost' in updates
    ? normalizeHostnameStringMap(updates.wslDistroOverridesByHost)
    : { ...current.wslDistroOverridesByHost };
  const installationMethodsByHost = persistInstallationSettings
    ? updatedInstallationMethodsByHost
    : omitCurrentHost(updatedInstallationMethodsByHost, hostnameKey);
  const wslDistroOverridesByHost = persistInstallationSettings
    ? updatedWslDistroOverridesByHost
    : omitCurrentHost(updatedWslDistroOverridesByHost, hostnameKey);
  const discoveredModels = normalizeCodexDiscoveredModels(
    updates.discoveredModels ?? current.discoveredModels,
  );
  const visibleModels = normalizeCodexVisibleModels(
    'visibleModels' in updates ? updates.visibleModels : current.visibleModels,
    discoveredModels,
  );
  const modelAliases = pruneCodexModelAliases(
    normalizeCodexModelAliases(updates.modelAliases ?? current.modelAliases, discoveredModels),
    getCodexAliasModelIds(visibleModels, discoveredModels),
  );

  if (
    persistInstallationSettings
    && Object.keys(installationMethodsByHost).length === 0
    && current.installationMethod !== DEFAULT_CODEX_PROVIDER_SETTINGS.installationMethod
  ) {
    installationMethodsByHost[hostnameKey] = current.installationMethod;
  }

  if (
    persistInstallationSettings
    && Object.keys(wslDistroOverridesByHost).length === 0
    && current.wslDistroOverride
  ) {
    wslDistroOverridesByHost[hostnameKey] = current.wslDistroOverride;
  }

  if (persistInstallationSettings && 'installationMethod' in updates) {
    installationMethodsByHost[hostnameKey] = normalizeCodexInstallationMethod(updates.installationMethod);
  }

  if (persistInstallationSettings && 'wslDistroOverride' in updates) {
    const normalizedDistroOverride = normalizeOptionalString(updates.wslDistroOverride);
    if (normalizedDistroOverride) {
      wslDistroOverridesByHost[hostnameKey] = normalizedDistroOverride;
    } else {
      delete wslDistroOverridesByHost[hostnameKey];
    }
  }

  const next: CodexProviderSettings = {
    ...current,
    ...updates,
    discoveredModels,
    modelAliases,
    visibleModels,
    installationMethod: persistInstallationSettings
      ? installationMethodsByHost[hostnameKey] ?? DEFAULT_CODEX_PROVIDER_SETTINGS.installationMethod
      : DEFAULT_CODEX_PROVIDER_SETTINGS.installationMethod,
    installationMethodsByHost,
    wslDistroOverride: persistInstallationSettings
      ? wslDistroOverridesByHost[hostnameKey] ?? DEFAULT_CODEX_PROVIDER_SETTINGS.wslDistroOverride
      : DEFAULT_CODEX_PROVIDER_SETTINGS.wslDistroOverride,
    wslDistroOverridesByHost,
  };

  setProviderConfig(settings, 'codex', {
    enabled: next.enabled,
    safeMode: next.safeMode,
    cliPath: next.cliPath,
    cliPathsByHost: next.cliPathsByHost,
    customModels: next.customModels,
    discoveredModels: next.discoveredModels,
    modelAliases: next.modelAliases,
    visibleModels: next.visibleModels,
    enableUltraEffort: next.enableUltraEffort,
    reasoningSummary: next.reasoningSummary,
    environmentVariables: next.environmentVariables,
    environmentHash: next.environmentHash,
    catalogTimestamp: next.catalogTimestamp,
    catalogFingerprint: next.catalogFingerprint,
    installationMethodsByHost,
    wslDistroOverridesByHost,
  });
  if ('visibleModels' in updates) {
    retargetRemovedCodexSelections(settings, next);
  }
  return next;
}
