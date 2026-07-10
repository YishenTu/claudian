import { getProviderConfig, setProviderConfig } from '../../core/providers/providerConfig';
import { getProviderEnvironmentVariables } from '../../core/providers/providerEnvironment';
import { DEFAULT_REASONING_VALUE } from '../../core/providers/reasoning';
import type { HostnameCliPaths } from '../../core/types/settings';
import {
  getHostnameKey,
  getLegacyHostnameKey,
  migrateLegacyHostnameKeyedMap,
} from '../../utils/env';
import {
  type CodexDiscoveredModel,
  findCodexModel,
  getCodexDefaultReasoningEffort,
  getDefaultCodexModel,
  normalizeCodexDiscoveredModels,
} from './models';
import { toCodexRuntimeModelId } from './modelSelection';
import { CODEX_SPARK_MODEL } from './types/models';

export type CodexSafeMode = 'workspace-write' | 'read-only';
export type CodexReasoningSummary = 'auto' | 'concise' | 'detailed' | 'none';
export type CodexInstallationMethod = 'native-windows' | 'wsl';
export type HostnameInstallationMethods = Record<string, CodexInstallationMethod>;

export interface CodexProviderConfig {
  enabled: boolean;
  safeMode: CodexSafeMode;
  cliPath: string;
  cliPathsByHost: HostnameCliPaths;
  customModels: string;
  discoveredModels: CodexDiscoveredModel[];
  visibleModels: string[] | null;
  reasoningSummary: CodexReasoningSummary;
  environmentVariables: string;
  environmentHash: string;
  installationMethodsByHost: HostnameInstallationMethods;
  wslDistroOverridesByHost: HostnameCliPaths;
}

export interface NormalizeCodexStoredConfigContext {
  platform?: NodeJS.Platform;
  hostnameKey?: string;
  legacyHostnameKey?: string;
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

function shouldPersistCodexInstallationSettings(): boolean {
  return process.platform === 'win32';
}

function omitCurrentHost<T>(entries: Record<string, T>, hostnameKey: string): Record<string, T> {
  const next = { ...entries };
  delete next[hostnameKey];
  delete next[getLegacyHostnameKey()];
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
  visibleModels: CodexProviderConfig['visibleModels'];
  reasoningSummary: CodexProviderConfig['reasoningSummary'];
  environmentVariables: CodexProviderConfig['environmentVariables'];
  environmentHash: CodexProviderConfig['environmentHash'];
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
  visibleModels: null,
  reasoningSummary: 'detailed',
  environmentVariables: '',
  environmentHash: '',
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
  const modelMetadata = findCodexModel(getCodexProviderSettings(settings).discoveredModels, model);
  settings.effortLevel = modelMetadata
    ? getCodexDefaultReasoningEffort(modelMetadata)
    : DEFAULT_REASONING_VALUE;
  if (shouldDisableCodexReasoningSummary(model)) {
    updateCodexProviderSettings(settings, { reasoningSummary: 'none' });
  }
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

export function createCodexVisibleModelFilter(
  value: unknown,
  discoveredModels: CodexDiscoveredModel[],
): string[] | null {
  const normalized = normalizeCodexVisibleModels(value, discoveredModels);
  return normalized !== null
    && discoveredModels.length > 0
    && normalized.length === discoveredModels.length
    ? null
    : normalized;
}

export function getVisibleCodexModelIds(
  visibleModels: string[] | null,
  discoveredModels: CodexDiscoveredModel[],
): string[] {
  return visibleModels === null
    ? discoveredModels.map(model => model.model)
    : normalizeCodexVisibleModels(visibleModels, discoveredModels) ?? [];
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

  const fallbackModel = getDefaultCodexModel(
    next.discoveredModels.filter(model => visibleModelIds.has(model.model)),
  );
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
    ensureCodexProjectionMap(settings, 'savedProviderEffort').codex = getCodexDefaultReasoningEffort(fallbackModel);
    ensureCodexProjectionMap(settings, 'savedProviderServiceTier').codex = fallbackServiceTier;
  }

  const nextTopLevelModel = maybeRetarget(settings.model);
  if (nextTopLevelModel) {
    settings.model = nextTopLevelModel;
    settings.effortLevel = getCodexDefaultReasoningEffort(fallbackModel);
    settings.serviceTier = fallbackServiceTier;
  }

  const nextTitleGenerationModel = maybeRetarget(settings.titleGenerationModel);
  if (nextTitleGenerationModel) {
    settings.titleGenerationModel = nextTitleGenerationModel;
  }
}

function normalizeInstallationMethodsByHost(value: unknown): HostnameInstallationMethods {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }

  const result: HostnameInstallationMethods = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof key === 'string' && key.trim()) {
      result[key] = normalizeCodexInstallationMethod(entry);
    }
  }
  return result;
}

function hasOwnEntry<T>(entries: Record<string, T>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(entries, key);
}

function getCodexStoredConfig(
  settings: Record<string, unknown>,
  hostnameKey: string,
  legacyHostnameKey: string,
): CodexProviderConfig {
  const config = getProviderConfig(settings, 'codex');
  const normalizedCliPathsByHost = normalizeHostnameCliPaths(config.cliPathsByHost ?? settings.codexCliPathsByHost);
  const normalizedInstallationMethodsByHost = normalizeInstallationMethodsByHost(config.installationMethodsByHost);
  const normalizedWslDistroOverridesByHost = normalizeHostnameCliPaths(config.wslDistroOverridesByHost);
  const cliPathsByHost = migrateLegacyHostnameKeyedMap(normalizedCliPathsByHost, hostnameKey, legacyHostnameKey);
  const installationMethodsByHost = migrateLegacyHostnameKeyedMap(
    normalizedInstallationMethodsByHost,
    hostnameKey,
    legacyHostnameKey,
  );
  const wslDistroOverridesByHost = migrateLegacyHostnameKeyedMap(
    normalizedWslDistroOverridesByHost,
    hostnameKey,
    legacyHostnameKey,
  );
  const discoveredModels = normalizeCodexDiscoveredModels(config.discoveredModels);

  return {
    enabled: (config.enabled as boolean | undefined)
      ?? (settings.codexEnabled as boolean | undefined)
      ?? DEFAULT_CODEX_PROVIDER_CONFIG.enabled,
    safeMode: (config.safeMode as CodexSafeMode | undefined)
      ?? (settings.codexSafeMode as CodexSafeMode | undefined)
      ?? DEFAULT_CODEX_PROVIDER_CONFIG.safeMode,
    cliPath: (config.cliPath as string | undefined)
      ?? (settings.codexCliPath as string | undefined)
      ?? DEFAULT_CODEX_PROVIDER_CONFIG.cliPath,
    cliPathsByHost,
    customModels: (config.customModels as string | undefined)
      ?? DEFAULT_CODEX_PROVIDER_CONFIG.customModels,
    discoveredModels,
    visibleModels: normalizeCodexVisibleModels(config.visibleModels, discoveredModels),
    reasoningSummary: (config.reasoningSummary as CodexReasoningSummary | undefined)
      ?? (settings.codexReasoningSummary as CodexReasoningSummary | undefined)
      ?? DEFAULT_CODEX_PROVIDER_CONFIG.reasoningSummary,
    environmentVariables: (config.environmentVariables as string | undefined)
      ?? getProviderEnvironmentVariables(settings, 'codex')
      ?? DEFAULT_CODEX_PROVIDER_CONFIG.environmentVariables,
    environmentHash: (config.environmentHash as string | undefined)
      ?? (settings.lastCodexEnvHash as string | undefined)
      ?? DEFAULT_CODEX_PROVIDER_CONFIG.environmentHash,
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
    legacyHostnameKey: context.legacyHostnameKey ?? getLegacyHostnameKey(),
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
    legacyHostnameKey,
  } = getNormalizedCodexStoredConfigContext(context);
  const storedConfig = getCodexStoredConfig(settings, hostnameKey, legacyHostnameKey);
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
    delete installationMethodsByHost[legacyHostnameKey];
    delete wslDistroOverridesByHost[hostnameKey];
    delete wslDistroOverridesByHost[legacyHostnameKey];
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
  const legacyHostnameKey = getLegacyHostnameKey();
  const storedConfig = getCodexStoredConfig(settings, hostnameKey, legacyHostnameKey);
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
    ? normalizeHostnameCliPaths(updates.wslDistroOverridesByHost)
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
    visibleModels: next.visibleModels,
    reasoningSummary: next.reasoningSummary,
    environmentVariables: next.environmentVariables,
    environmentHash: next.environmentHash,
    installationMethodsByHost,
    wslDistroOverridesByHost,
  });
  if ('visibleModels' in updates) {
    retargetRemovedCodexSelections(settings, next);
  }
  return next;
}
