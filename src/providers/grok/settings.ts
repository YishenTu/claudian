import { getProviderConfig, setProviderConfig } from '../../core/providers/providerConfig';
import { getProviderEnvironmentVariables } from '../../core/providers/providerEnvironment';
import type { HostnameCliPaths } from '../../core/types/settings';
import {
  getHostnameKey,
  getLegacyHostnameKey,
  migrateLegacyHostnameKeyedMap,
} from '../../utils/env';

/** Grok Build sandbox profiles (see Grok docs: workspace, read-only, strict, off). */
export type GrokSafeMode = 'workspace' | 'read-only';

export interface GrokProviderConfig {
  enabled: boolean;
  safeMode: GrokSafeMode;
  cliPath: string;
  cliPathsByHost: HostnameCliPaths;
  environmentVariables: string;
  environmentHash: string;
}

export type GrokProviderSettings = GrokProviderConfig;

export const DEFAULT_GROK_PROVIDER_SETTINGS: Readonly<GrokProviderConfig> = Object.freeze({
  enabled: false,
  safeMode: 'workspace',
  cliPath: '',
  cliPathsByHost: {},
  environmentVariables: '',
  environmentHash: '',
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

/** Map legacy Codex-style values and accept current Grok sandbox profile names. */
export function normalizeGrokSafeMode(value: unknown): GrokSafeMode {
  if (value === 'read-only' || value === 'read_only' || value === 'readonly') {
    return 'read-only';
  }
  // Legacy extract used workspace-write (Codex naming).
  if (value === 'workspace-write' || value === 'workspace_write' || value === 'workspace') {
    return 'workspace';
  }
  return DEFAULT_GROK_PROVIDER_SETTINGS.safeMode;
}

export function getGrokProviderSettings(
  settings: Record<string, unknown>,
): GrokProviderSettings {
  const config = getProviderConfig(settings, 'grok');
  const normalizedCliPathsByHost = normalizeHostnameCliPaths(config.cliPathsByHost);
  const cliPathsByHost = Object.keys(normalizedCliPathsByHost).length > 0
    ? migrateLegacyHostnameKeyedMap(
      normalizedCliPathsByHost,
      getHostnameKey(),
      getLegacyHostnameKey(),
    )
    : normalizedCliPathsByHost;

  return {
    enabled: (config.enabled as boolean | undefined)
      ?? DEFAULT_GROK_PROVIDER_SETTINGS.enabled,
    safeMode: normalizeGrokSafeMode(config.safeMode),
    cliPath: (config.cliPath as string | undefined)
      ?? DEFAULT_GROK_PROVIDER_SETTINGS.cliPath,
    cliPathsByHost,
    environmentVariables: (config.environmentVariables as string | undefined)
      ?? getProviderEnvironmentVariables(settings, 'grok')
      ?? DEFAULT_GROK_PROVIDER_SETTINGS.environmentVariables,
    environmentHash: (config.environmentHash as string | undefined)
      ?? DEFAULT_GROK_PROVIDER_SETTINGS.environmentHash,
  };
}

export function updateGrokProviderSettings(
  settings: Record<string, unknown>,
  updates: Partial<GrokProviderSettings>,
): GrokProviderSettings {
  const current = getGrokProviderSettings(settings);
  const hostnameKey = getHostnameKey();
  const nextCliPathsByHost = 'cliPathsByHost' in updates
    ? normalizeHostnameCliPaths(updates.cliPathsByHost)
    : { ...current.cliPathsByHost };
  let nextCliPath = 'cliPathsByHost' in updates
    ? (
      typeof updates.cliPath === 'string'
        ? updates.cliPath.trim()
        : DEFAULT_GROK_PROVIDER_SETTINGS.cliPath
    )
    : current.cliPath.trim();

  if ('cliPath' in updates && !('cliPathsByHost' in updates)) {
    const trimmedCliPath = typeof updates.cliPath === 'string' ? updates.cliPath.trim() : '';
    if (trimmedCliPath) {
      nextCliPathsByHost[hostnameKey] = trimmedCliPath;
    } else {
      delete nextCliPathsByHost[hostnameKey];
    }
    nextCliPath = DEFAULT_GROK_PROVIDER_SETTINGS.cliPath;
  }

  const next: GrokProviderSettings = {
    ...current,
    ...updates,
    safeMode: 'safeMode' in updates
      ? normalizeGrokSafeMode(updates.safeMode)
      : current.safeMode,
    cliPath: nextCliPath,
    cliPathsByHost: nextCliPathsByHost,
  };

  setProviderConfig(settings, 'grok', {
    enabled: next.enabled,
    safeMode: next.safeMode,
    cliPath: next.cliPath,
    cliPathsByHost: next.cliPathsByHost,
    environmentVariables: next.environmentVariables,
    environmentHash: next.environmentHash,
  });

  return next;
}
