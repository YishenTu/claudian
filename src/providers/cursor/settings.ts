import { getProviderConfig, setProviderConfig } from '../../core/providers/providerConfig';
import { getProviderEnvironmentVariables } from '../../core/providers/providerEnvironment';
import type { HostnameCliPaths } from '../../core/types/settings';
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

export interface CursorProviderSettings {
  enabled: boolean;
  cliPath: string;
  cliPathsByHost: HostnameCliPaths;
  environmentVariables: string;
  environmentHash: string;
}

export const DEFAULT_CURSOR_PROVIDER_SETTINGS: Readonly<CursorProviderSettings> = Object.freeze({
  enabled: false,
  cliPath: '',
  cliPathsByHost: {},
  environmentVariables: '',
  environmentHash: '',
});

export function getCursorProviderSettings(settings: Record<string, unknown>): CursorProviderSettings {
  const config = getProviderConfig(settings, 'cursor');

  return {
    enabled: (config.enabled as boolean | undefined) ?? DEFAULT_CURSOR_PROVIDER_SETTINGS.enabled,
    cliPath: (config.cliPath as string | undefined) ?? DEFAULT_CURSOR_PROVIDER_SETTINGS.cliPath,
    cliPathsByHost: normalizeHostnameCliPaths(config.cliPathsByHost),
    environmentVariables: (config.environmentVariables as string | undefined)
      ?? getProviderEnvironmentVariables(settings, 'cursor')
      ?? DEFAULT_CURSOR_PROVIDER_SETTINGS.environmentVariables,
    environmentHash: (config.environmentHash as string | undefined)
      ?? DEFAULT_CURSOR_PROVIDER_SETTINGS.environmentHash,
  };
}

export function updateCursorProviderSettings(
  settings: Record<string, unknown>,
  updates: Partial<CursorProviderSettings>,
): CursorProviderSettings {
  const current = getCursorProviderSettings(settings);
  const next: CursorProviderSettings = {
    ...current,
    ...updates,
    cliPathsByHost: updates.cliPathsByHost
      ? normalizeHostnameCliPaths(updates.cliPathsByHost)
      : { ...current.cliPathsByHost },
  };

  setProviderConfig(settings, 'cursor', {
    enabled: next.enabled,
    cliPath: next.cliPath,
    cliPathsByHost: next.cliPathsByHost,
    environmentVariables: next.environmentVariables,
    environmentHash: next.environmentHash,
  });
  return next;
}
