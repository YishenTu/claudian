import { getInstallationKey } from '@/core/device/InstallationKey';
import { getProviderConfig, setProviderConfig } from '@/core/providers/providerConfig';
import { getProviderEnvironmentVariables } from '@/core/providers/providerEnvironment';
import { normalizeHostnameStringMap } from '@/core/providers/settings/HostnameStringMap';
import {
  readStoredBoolean,
  readStoredString,
} from '@/core/providers/settings/storedSettings';

import {
  DEFAULT_ANTIGRAVITY_MODEL,
  normalizeAntigravityDiscoveredModels,
} from './models';
import type {
  AntigravityAuthMethod,
  AntigravityPermissionMode,
  AntigravityProviderSettings,
} from './types';

export const DEFAULT_ANTIGRAVITY_VISIBLE_MODELS = [
  'gemini-3.8-flash-high',
  'gemini-3.8-flash-medium',
  'gemini-3.7-flash-high',
  'gemini-pro-agent',
];

export const DEFAULT_ANTIGRAVITY_PROVIDER_SETTINGS: Readonly<AntigravityProviderSettings> = Object.freeze({
  enabled: false,
  cliPath: '',
  cliPathsByHost: {},
  environmentHash: '',
  environmentVariables: '',
  authMethod: 'oauth-personal',
  geminiApiKey: '',
  selectedModel: DEFAULT_ANTIGRAVITY_MODEL,
  visibleModels: [...DEFAULT_ANTIGRAVITY_VISIBLE_MODELS],
  discoveredModels: [],
  permissionMode: 'default',
  serverArguments: '',
  debugLogging: false,
  autoDownload: true,
});

export function normalizeAntigravityVisibleModels(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [...DEFAULT_ANTIGRAVITY_VISIBLE_MODELS];
  }

  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== 'string') {
      continue;
    }
    const trimmed = item.trim();
    if (!trimmed || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    normalized.push(trimmed);
  }

  return normalized.length > 0 ? normalized : [...DEFAULT_ANTIGRAVITY_VISIBLE_MODELS];
}

export function getAntigravityProviderSettings(
  settings: unknown,
): AntigravityProviderSettings {
  const config = getProviderConfig(settings, 'antigravity') ?? {};

  const authMethodRaw = typeof config.authMethod === 'string' ? config.authMethod : 'oauth-personal';
  const authMethod: AntigravityAuthMethod = (
    authMethodRaw === 'gemini-api-key'
    || authMethodRaw === 'oauth-business'
    || authMethodRaw === 'agent-platform'
  ) ? authMethodRaw : 'oauth-personal';

  const permissionModeRaw = typeof config.permissionMode === 'string' ? config.permissionMode : 'default';
  const permissionMode: AntigravityPermissionMode = (
    permissionModeRaw === 'auto_edit'
    || permissionModeRaw === 'yolo'
  ) ? permissionModeRaw : 'default';

  return {
    enabled: readStoredBoolean(config.enabled, DEFAULT_ANTIGRAVITY_PROVIDER_SETTINGS.enabled),
    cliPath: readStoredString(config.cliPath, DEFAULT_ANTIGRAVITY_PROVIDER_SETTINGS.cliPath),
    cliPathsByHost: normalizeHostnameStringMap(config.cliPathsByHost),
    environmentHash: readStoredString(
      config.environmentHash,
      DEFAULT_ANTIGRAVITY_PROVIDER_SETTINGS.environmentHash,
    ),
    environmentVariables: readStoredString(
      config.environmentVariables,
      getProviderEnvironmentVariables(settings as Record<string, unknown>, 'antigravity')
        ?? DEFAULT_ANTIGRAVITY_PROVIDER_SETTINGS.environmentVariables,
    ),
    authMethod,
    geminiApiKey: readStoredString(config.geminiApiKey, ''),
    selectedModel: readStoredString(
      config.selectedModel,
      DEFAULT_ANTIGRAVITY_PROVIDER_SETTINGS.selectedModel,
    ),
    visibleModels: normalizeAntigravityVisibleModels(config.visibleModels),
    discoveredModels: normalizeAntigravityDiscoveredModels(config.discoveredModels),
    permissionMode,
    serverArguments: readStoredString(config.serverArguments, ''),
    debugLogging: readStoredBoolean(config.debugLogging, false),
    autoDownload: readStoredBoolean(config.autoDownload, true),
  };
}

export function updateAntigravityProviderSettings(
  settings: unknown,
  patch: Partial<AntigravityProviderSettings>,
): AntigravityProviderSettings {
  const current = getAntigravityProviderSettings(settings);
  const next: AntigravityProviderSettings = {
    ...current,
    ...patch,
    cliPathsByHost: patch.cliPathsByHost
      ? normalizeHostnameStringMap(patch.cliPathsByHost)
      : current.cliPathsByHost,
    visibleModels: patch.visibleModels
      ? normalizeAntigravityVisibleModels(patch.visibleModels)
      : current.visibleModels,
    discoveredModels: patch.discoveredModels
      ? normalizeAntigravityDiscoveredModels(patch.discoveredModels)
      : current.discoveredModels,
  };

  setProviderConfig(settings, 'antigravity', next);
  return next;
}

export function projectAntigravityModelSettings(
  settings: Record<string, unknown>,
): Record<string, unknown> {
  const config = getAntigravityProviderSettings(settings);
  return {
    ...config,
    cliPathsByHost: { ...config.cliPathsByHost },
    visibleModels: [...config.visibleModels],
  };
}

export function resolveHostAntigravityCliPath(
  settings: Record<string, unknown>,
  hostKey: string = getInstallationKey(),
): string {
  const config = getAntigravityProviderSettings(settings);
  return config.cliPathsByHost[hostKey] || config.cliPath;
}
