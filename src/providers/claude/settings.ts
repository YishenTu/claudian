import { getProviderConfig, setProviderConfig } from '../../core/providers/providerConfig';
import { getProviderEnvironmentVariables } from '../../core/providers/providerEnvironment';
import type { HostnameCliPaths } from '../../core/types/settings';
import {
  getHostnameKey,
  getLegacyHostnameKey,
  migrateLegacyHostnameKeyedMap,
} from '../../utils/env';

export const CLAUDE_SAFE_MODES = ['acceptEdits', 'auto', 'default'] as const;
export type ClaudeSafeMode = typeof CLAUDE_SAFE_MODES[number];
export type ClaudeSettingSource = 'user' | 'project' | 'local';
export type ClaudeInstallationMethod =
  | 'native-windows'
  | 'wsl1'
  | 'wsl2'
  | 'wsl-unconfigured';
export type ClaudeHostnameInstallationMethods = Record<string, ClaudeInstallationMethod>;

export interface ClaudeProviderSettings {
  safeMode: ClaudeSafeMode;
  cliPath: string;
  cliPathsByHost: HostnameCliPaths;
  loadUserSettings: boolean;
  enableChrome: boolean;
  enableBangBash: boolean;
  enableOpus1M: boolean;
  enableSonnet1M: boolean;
  customModels: string;
  lastModel: string;
  environmentVariables: string;
  environmentHash: string;
  installationMethod: ClaudeInstallationMethod;
  installationMethodsByHost: ClaudeHostnameInstallationMethods;
  wslDistroOverride: string;
  wslDistroOverridesByHost: HostnameCliPaths;
}

export const DEFAULT_CLAUDE_PROVIDER_SETTINGS: Readonly<ClaudeProviderSettings> = Object.freeze({
  safeMode: 'acceptEdits',
  cliPath: '',
  cliPathsByHost: {},
  loadUserSettings: true,
  enableChrome: false,
  enableBangBash: false,
  enableOpus1M: false,
  enableSonnet1M: false,
  customModels: '',
  lastModel: 'haiku',
  environmentVariables: '',
  environmentHash: '',
  installationMethod: 'native-windows',
  installationMethodsByHost: {},
  wslDistroOverride: '',
  wslDistroOverridesByHost: {},
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

function normalizeClaudeSafeMode(value: unknown): ClaudeSafeMode | undefined {
  return (CLAUDE_SAFE_MODES as readonly unknown[]).includes(value)
    ? value as ClaudeSafeMode
    : undefined;
}

function normalizeClaudeInstallationMethod(value: unknown): ClaudeInstallationMethod {
  if (value === 'wsl1' || value === 'wsl2' || value === 'wsl-unconfigured') return value;
  if (value === 'wsl') return 'wsl-unconfigured';
  return 'native-windows';
}

function normalizeInstallationMethodsByHost(value: unknown): ClaudeHostnameInstallationMethods {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key.trim())
      .map(([key, entry]) => [key, normalizeClaudeInstallationMethod(entry)]),
  );
}

export function isClaudeWslInstallationMethod(
  value: ClaudeInstallationMethod,
): value is 'wsl1' | 'wsl2' {
  return value === 'wsl1' || value === 'wsl2';
}

export function getClaudeProviderSettings(
  settings: Record<string, unknown>,
): ClaudeProviderSettings {
  const config = getProviderConfig(settings, 'claude');
  const normalizedCliPathsByHost = normalizeHostnameCliPaths(
    config.cliPathsByHost ?? settings.claudeCliPathsByHost,
  );
  const cliPathsByHost = Object.keys(normalizedCliPathsByHost).length > 0
    ? migrateLegacyHostnameKeyedMap(
      normalizedCliPathsByHost,
      getHostnameKey(),
      getLegacyHostnameKey(),
    )
    : normalizedCliPathsByHost;
  const hostnameKey = typeof getHostnameKey === 'function' ? getHostnameKey() : '';
  const installationMethodsByHost = normalizeInstallationMethodsByHost(config.installationMethodsByHost);
  const wslDistroOverridesByHost = normalizeHostnameCliPaths(config.wslDistroOverridesByHost);
  const installationMethod = installationMethodsByHost[hostnameKey]
    ?? normalizeClaudeInstallationMethod(config.installationMethod);

  return {
    safeMode: normalizeClaudeSafeMode(config.safeMode)
      ?? normalizeClaudeSafeMode(settings.claudeSafeMode)
      ?? DEFAULT_CLAUDE_PROVIDER_SETTINGS.safeMode,
    cliPath: (config.cliPath as string | undefined)
      ?? (settings.claudeCliPath as string | undefined)
      ?? DEFAULT_CLAUDE_PROVIDER_SETTINGS.cliPath,
    cliPathsByHost,
    loadUserSettings: (config.loadUserSettings as boolean | undefined)
      ?? (settings.loadUserClaudeSettings as boolean | undefined)
      ?? DEFAULT_CLAUDE_PROVIDER_SETTINGS.loadUserSettings,
    enableChrome: (config.enableChrome as boolean | undefined)
      ?? (settings.enableChrome as boolean | undefined)
      ?? DEFAULT_CLAUDE_PROVIDER_SETTINGS.enableChrome,
    enableBangBash: (config.enableBangBash as boolean | undefined)
      ?? (settings.enableBangBash as boolean | undefined)
      ?? DEFAULT_CLAUDE_PROVIDER_SETTINGS.enableBangBash,
    enableOpus1M: (config.enableOpus1M as boolean | undefined)
      ?? (settings.enableOpus1M as boolean | undefined)
      ?? DEFAULT_CLAUDE_PROVIDER_SETTINGS.enableOpus1M,
    enableSonnet1M: (config.enableSonnet1M as boolean | undefined)
      ?? (settings.enableSonnet1M as boolean | undefined)
      ?? DEFAULT_CLAUDE_PROVIDER_SETTINGS.enableSonnet1M,
    customModels: (config.customModels as string | undefined)
      ?? DEFAULT_CLAUDE_PROVIDER_SETTINGS.customModels,
    lastModel: (config.lastModel as string | undefined)
      ?? (settings.lastClaudeModel as string | undefined)
      ?? DEFAULT_CLAUDE_PROVIDER_SETTINGS.lastModel,
    environmentVariables: (config.environmentVariables as string | undefined)
      ?? getProviderEnvironmentVariables(settings, 'claude')
      ?? DEFAULT_CLAUDE_PROVIDER_SETTINGS.environmentVariables,
    environmentHash: (config.environmentHash as string | undefined)
      ?? (settings.lastEnvHash as string | undefined)
      ?? DEFAULT_CLAUDE_PROVIDER_SETTINGS.environmentHash,
    installationMethod,
    installationMethodsByHost,
    wslDistroOverride: installationMethod === 'wsl-unconfigured'
      ? ''
      : wslDistroOverridesByHost[hostnameKey]
        ?? (typeof config.wslDistroOverride === 'string' ? config.wslDistroOverride.trim() : ''),
    wslDistroOverridesByHost,
  };
}

export function resolveClaudeSettingSources(
  loadUserSettings: boolean,
): ClaudeSettingSource[] {
  return loadUserSettings
    ? ['user', 'project', 'local']
    : ['project', 'local'];
}

export function updateClaudeProviderSettings(
  settings: Record<string, unknown>,
  updates: Partial<ClaudeProviderSettings>,
): ClaudeProviderSettings {
  const current = getClaudeProviderSettings(settings);
  const hostnameKey = typeof getHostnameKey === 'function' ? getHostnameKey() : '';
  const installationMethodsByHost = 'installationMethodsByHost' in updates
    ? normalizeInstallationMethodsByHost(updates.installationMethodsByHost)
    : { ...current.installationMethodsByHost };
  const wslDistroOverridesByHost = 'wslDistroOverridesByHost' in updates
    ? normalizeHostnameCliPaths(updates.wslDistroOverridesByHost)
    : { ...current.wslDistroOverridesByHost };

  if ('installationMethod' in updates) {
    const method = normalizeClaudeInstallationMethod(updates.installationMethod);
    if (method !== current.installationMethod) delete wslDistroOverridesByHost[hostnameKey];
    installationMethodsByHost[hostnameKey] = method;
  }
  if ('wslDistroOverride' in updates) {
    const distro = typeof updates.wslDistroOverride === 'string'
      ? updates.wslDistroOverride.trim()
      : '';
    if (distro) wslDistroOverridesByHost[hostnameKey] = distro;
    else delete wslDistroOverridesByHost[hostnameKey];
  }

  const next = {
    ...current,
    ...updates,
    safeMode: 'safeMode' in updates
      ? normalizeClaudeSafeMode(updates.safeMode) ?? current.safeMode
      : current.safeMode,
    installationMethod: installationMethodsByHost[hostnameKey]
      ?? DEFAULT_CLAUDE_PROVIDER_SETTINGS.installationMethod,
    installationMethodsByHost,
    wslDistroOverride: wslDistroOverridesByHost[hostnameKey] ?? '',
    wslDistroOverridesByHost,
  };
  setProviderConfig(settings, 'claude', {
    ...next,
    installationMethodsByHost,
    wslDistroOverridesByHost,
  });
  return next;
}
