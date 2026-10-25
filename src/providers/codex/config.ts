import { getInstallationKey } from '@/core/device/InstallationKey';

import { replaceProviderConfig } from '../../core/providers/providerConfig';
import { normalizeHostnameStringMap } from '../../core/providers/settings/HostnameStringMap';
import {
  readStoredBoolean,
  readStoredString,
} from '../../core/providers/settings/storedSettings';
import type { HostnameCLIPaths } from '../../core/types/settings';
import {
  type CodexDiscoveredModel,
  getDefaultCodexModel,
  normalizeCodexDiscoveredModels
} from './models';
import { toCodexRuntimeModelId } from './modelSelection';
import { CODEX_SPARK_MODEL } from './types/models';

export type CodexSafeMode = 'workspace-write' | 'read-only';
type CodexResponseStyle = 'pragmatic' | 'friendly' | 'none';
type CodexResponseVerbosity = 'default' | 'low' | 'medium' | 'high';
type CodexReasoningSummary = 'auto' | 'concise' | 'detailed' | 'none';
export type CodexInstallationMethod = 'native-windows' | 'wsl';
type HostnameInstallationMethods = Record<string, CodexInstallationMethod>;

const CODEX_SAFE_MODES = ['workspace-write', 'read-only'] as const;
const CODEX_REASONING_SUMMARIES = ['auto', 'concise', 'detailed', 'none'] as const;

export interface CodexProviderConfig {
  enabled: boolean;
  safeMode: CodexSafeMode;
  cliPath: string;
  cliPathsByHost: HostnameCLIPaths;
  discoveredModels: CodexDiscoveredModel[];
  modelAliases: Record<string, string>;
  visibleModels: string[] | null;
  enableUltraEffort: boolean;
  responseStyle: CodexResponseStyle;
  responseVerbosity: CodexResponseVerbosity;
  reasoningSummary: CodexReasoningSummary;
  environmentVariables: string;
  environmentHash: string;
  /** Fingerprint of the inputs that select the native session store, endpoint, or account. */
  sessionEnvironmentHash: string;
  catalogTimestamp: number;
  catalogFingerprint: string;
  installationMethodsByHost: HostnameInstallationMethods;
  wslDistroOverridesByHost: HostnameCLIPaths;
}

export interface CodexProviderSettings {
  enabled: CodexProviderConfig['enabled'];
  safeMode: CodexProviderConfig['safeMode'];
  cliPath: CodexProviderConfig['cliPath'];
  cliPathsByHost: CodexProviderConfig['cliPathsByHost'];
  discoveredModels: CodexProviderConfig['discoveredModels'];
  modelAliases: CodexProviderConfig['modelAliases'];
  visibleModels: CodexProviderConfig['visibleModels'];
  enableUltraEffort: CodexProviderConfig['enableUltraEffort'];
  responseStyle: CodexProviderConfig['responseStyle'];
  responseVerbosity: CodexProviderConfig['responseVerbosity'];
  reasoningSummary: CodexProviderConfig['reasoningSummary'];
  environmentVariables: CodexProviderConfig['environmentVariables'];
  environmentHash: CodexProviderConfig['environmentHash'];
  sessionEnvironmentHash: CodexProviderConfig['sessionEnvironmentHash'];
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
  discoveredModels: [],
  modelAliases: {},
  visibleModels: [],
  enableUltraEffort: false,
  responseStyle: 'pragmatic',
  responseVerbosity: 'default',
  reasoningSummary: 'detailed',
  environmentVariables: '',
  environmentHash: '',
  sessionEnvironmentHash: '',
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

export function shouldDisableCodexReasoningSummary(model: string | undefined): boolean {
  return model ? toCodexRuntimeModelId(model) === CODEX_SPARK_MODEL : false;
}

export function resolveCodexReasoningSummary(
  settings: Pick<CodexProviderSettings, 'reasoningSummary'>,
  model: string | undefined,
): CodexReasoningSummary {
  if (shouldDisableCodexReasoningSummary(model)) {
    return 'none';
  }

  return settings.reasoningSummary;
}

export function normalizeCodexVisibleModels(value: unknown): string[] | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (!Array.isArray(value)) {
    return null;
  }

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
    ) {
      continue;
    }

    seen.add(modelId);
    visibleModels.push(modelId);
  }

  return visibleModels;
}

export function normalizeCodexModelAliases(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }

  const entries: Array<[string, string]> = [];
  for (const [rawModelId, rawAlias] of Object.entries(value as Record<string, unknown>)) {
    if (typeof rawAlias !== 'string') {
      continue;
    }

    const modelId = rawModelId.trim();
    const alias = rawAlias.trim();
    if (!modelId || !alias) {
      continue;
    }
    entries.push([modelId, alias]);
  }
  return Object.fromEntries(entries);
}

export function getVisibleCodexModelIds(
  visibleModels: string[] | null,
  discoveredModels: CodexDiscoveredModel[],
): string[] {
  if (visibleModels !== null) {
    return normalizeCodexVisibleModels(visibleModels) ?? [];
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

/** Decodes a stored Codex configuration without selecting this host's installation entries. */
export function decodeCodexStoredConfig(
  config: Readonly<Record<string, unknown>>,
): CodexProviderConfig {
  const cliPathsByHost = normalizeHostnameStringMap(config.cliPathsByHost,);
  const installationMethodsByHost = normalizeInstallationMethodsByHost(config.installationMethodsByHost,);
  const wslDistroOverridesByHost = normalizeHostnameStringMap(config.wslDistroOverridesByHost,);
  const discoveredModels = normalizeCodexDiscoveredModels(config.discoveredModels ?? config.selectedModels);
  const visibleModels = normalizeCodexVisibleModels(config.visibleModels);

  return {
    enabled: readStoredBoolean(
      config.enabled,
      DEFAULT_CODEX_PROVIDER_CONFIG.enabled,
    ),
    safeMode: readStoredCodexSafeMode(
      config.safeMode,
      DEFAULT_CODEX_PROVIDER_CONFIG.safeMode,
    ),
    cliPath: readStoredString(
      config.cliPath,
      DEFAULT_CODEX_PROVIDER_CONFIG.cliPath,
    ),
    cliPathsByHost,
    discoveredModels,
    modelAliases: pruneCodexModelAliases(
      normalizeCodexModelAliases(config.modelAliases),
      getCodexAliasModelIds(visibleModels, discoveredModels),
    ),
    visibleModels,
    enableUltraEffort: config.enableUltraEffort === true,
    responseStyle: config.responseStyle === 'friendly' || config.responseStyle === 'none'
      ? config.responseStyle : 'pragmatic',
    responseVerbosity: config.responseVerbosity === 'low' || config.responseVerbosity === 'medium' || config.responseVerbosity === 'high'
      ? config.responseVerbosity : 'default',
    reasoningSummary: readStoredCodexReasoningSummary(
      config.reasoningSummary,
      DEFAULT_CODEX_PROVIDER_CONFIG.reasoningSummary,
    ),
    environmentVariables: readStoredString(
      config.environmentVariables,
      DEFAULT_CODEX_PROVIDER_CONFIG.environmentVariables,
    ),
    environmentHash: readStoredString(
      config.environmentHash,
      DEFAULT_CODEX_PROVIDER_CONFIG.environmentHash,
    ),
    sessionEnvironmentHash: readStoredString(
      config.sessionEnvironmentHash,
      DEFAULT_CODEX_PROVIDER_CONFIG.sessionEnvironmentHash,
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

/** Decodes a stored Codex configuration with this host's installation selected. */
export function decodeCodexConfig(
  config: Readonly<Record<string, unknown>>,
): CodexProviderSettings {
  const hostnameKey = getInstallationKey();
  const storedConfig = decodeCodexStoredConfig(config);
  return {
    ...storedConfig,
    installationMethod: storedConfig.installationMethodsByHost[hostnameKey]
      ?? DEFAULT_CODEX_PROVIDER_SETTINGS.installationMethod,
    wslDistroOverride: storedConfig.wslDistroOverridesByHost[hostnameKey]
      ?? DEFAULT_CODEX_PROVIDER_SETTINGS.wslDistroOverride,
  };
}

/** Applies updates to a stored Codex configuration in place, keeping only Codex-owned keys. */
export function updateCodexConfig(
  config: Record<string, unknown>,
  updates: Partial<CodexProviderSettings>,
): CodexProviderSettings {
  const current = decodeCodexConfig(config);
  const hostnameKey = getInstallationKey();
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
  const discoveredModels = normalizeCodexDiscoveredModels(updates.discoveredModels ?? current.discoveredModels,);
  const visibleModels = normalizeCodexVisibleModels('visibleModels' in updates ? updates.visibleModels : current.visibleModels);
  const modelAliases = pruneCodexModelAliases(
    normalizeCodexModelAliases(updates.modelAliases ?? current.modelAliases),
    getCodexAliasModelIds(visibleModels, discoveredModels),
  );

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

  replaceProviderConfig(config, {
    enabled: next.enabled,
    safeMode: next.safeMode,
    cliPath: next.cliPath,
    cliPathsByHost: next.cliPathsByHost,
    discoveredModels: next.discoveredModels,
    modelAliases: next.modelAliases,
    visibleModels: next.visibleModels,
    enableUltraEffort: next.enableUltraEffort,
    responseStyle: next.responseStyle,
    responseVerbosity: next.responseVerbosity,
    reasoningSummary: next.reasoningSummary,
    environmentVariables: next.environmentVariables,
    environmentHash: next.environmentHash,
    sessionEnvironmentHash: next.sessionEnvironmentHash,
    catalogTimestamp: next.catalogTimestamp,
    catalogFingerprint: next.catalogFingerprint,
    installationMethodsByHost,
    wslDistroOverridesByHost,
  });
  return next;
}
