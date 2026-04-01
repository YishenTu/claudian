import { getProviderConfig, setProviderConfig } from '../../core/providers/providerConfig';
import { getProviderEnvironmentVariables } from '../../core/providers/providerEnvironment';
import type { HostnameCliPaths } from '../../core/types/settings';

export type CodexSafeMode = 'workspace-write' | 'read-only';
export type CodexReasoningSummary = 'auto' | 'concise' | 'detailed' | 'none';

export interface CodexProviderSettings {
  enabled: boolean;
  safeMode: CodexSafeMode;
  cliPath: string;
  cliPathsByHost: HostnameCliPaths;
  reasoningSummary: CodexReasoningSummary;
  environmentVariables: string;
  environmentHash: string;
}

export const DEFAULT_CODEX_PROVIDER_SETTINGS: Readonly<CodexProviderSettings> = Object.freeze({
  enabled: false,
  safeMode: 'workspace-write',
  cliPath: '',
  cliPathsByHost: {},
  reasoningSummary: 'detailed',
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

export function getCodexProviderSettings(
  settings: Record<string, unknown>,
): CodexProviderSettings {
  const config = getProviderConfig(settings, 'codex');

  return {
    enabled: (config.enabled as boolean | undefined)
      ?? (settings.codexEnabled as boolean | undefined)
      ?? DEFAULT_CODEX_PROVIDER_SETTINGS.enabled,
    safeMode: (config.safeMode as CodexSafeMode | undefined)
      ?? (settings.codexSafeMode as CodexSafeMode | undefined)
      ?? DEFAULT_CODEX_PROVIDER_SETTINGS.safeMode,
    cliPath: (config.cliPath as string | undefined)
      ?? (settings.codexCliPath as string | undefined)
      ?? DEFAULT_CODEX_PROVIDER_SETTINGS.cliPath,
    cliPathsByHost: normalizeHostnameCliPaths(config.cliPathsByHost ?? settings.codexCliPathsByHost),
    reasoningSummary: (config.reasoningSummary as CodexReasoningSummary | undefined)
      ?? (settings.codexReasoningSummary as CodexReasoningSummary | undefined)
      ?? DEFAULT_CODEX_PROVIDER_SETTINGS.reasoningSummary,
    environmentVariables: (config.environmentVariables as string | undefined)
      ?? getProviderEnvironmentVariables(settings, 'codex')
      ?? DEFAULT_CODEX_PROVIDER_SETTINGS.environmentVariables,
    environmentHash: (config.environmentHash as string | undefined)
      ?? (settings.lastCodexEnvHash as string | undefined)
      ?? DEFAULT_CODEX_PROVIDER_SETTINGS.environmentHash,
  };
}

export function updateCodexProviderSettings(
  settings: Record<string, unknown>,
  updates: Partial<CodexProviderSettings>,
): CodexProviderSettings {
  const next = {
    ...getCodexProviderSettings(settings),
    ...updates,
  };
  setProviderConfig(settings, 'codex', next);
  return next;
}
