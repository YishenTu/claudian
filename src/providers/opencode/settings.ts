import { getProviderConfig, setProviderConfig } from '../../core/providers/providerConfig';
import { getProviderEnvironmentVariables } from '../../core/providers/providerEnvironment';
import {
  normalizeOpencodeDiscoveredModels,
  type OpencodeDiscoveredModel,
} from './models';

export interface OpencodeProviderSettings {
  cliPath: string;
  discoveredModels: OpencodeDiscoveredModel[];
  enabled: boolean;
  environmentVariables: string;
  prewarm: boolean;
  visibleModels: string[];
}

export const DEFAULT_OPENCODE_PROVIDER_SETTINGS: Readonly<OpencodeProviderSettings> = Object.freeze({
  cliPath: '',
  discoveredModels: [],
  enabled: false,
  environmentVariables: '',
  prewarm: true,
  visibleModels: [],
});

export function normalizeOpencodeVisibleModels(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== 'string') {
      continue;
    }

    const trimmed = entry.trim();
    if (!trimmed || seen.has(trimmed)) {
      continue;
    }

    seen.add(trimmed);
    normalized.push(trimmed);
  }

  return normalized;
}

export function getOpencodeProviderSettings(
  settings: Record<string, unknown>,
): OpencodeProviderSettings {
  const config = getProviderConfig(settings, 'opencode');
  return {
    cliPath: (config.cliPath as string | undefined)
      ?? DEFAULT_OPENCODE_PROVIDER_SETTINGS.cliPath,
    discoveredModels: normalizeOpencodeDiscoveredModels(config.discoveredModels),
    enabled: (config.enabled as boolean | undefined)
      ?? DEFAULT_OPENCODE_PROVIDER_SETTINGS.enabled,
    environmentVariables: (config.environmentVariables as string | undefined)
      ?? getProviderEnvironmentVariables(settings, 'opencode')
      ?? DEFAULT_OPENCODE_PROVIDER_SETTINGS.environmentVariables,
    prewarm: (config.prewarm as boolean | undefined)
      ?? DEFAULT_OPENCODE_PROVIDER_SETTINGS.prewarm,
    visibleModels: normalizeOpencodeVisibleModels(config.visibleModels),
  };
}

export function updateOpencodeProviderSettings(
  settings: Record<string, unknown>,
  updates: Partial<OpencodeProviderSettings>,
): OpencodeProviderSettings {
  const next: OpencodeProviderSettings = {
    ...getOpencodeProviderSettings(settings),
    ...updates,
  };

  setProviderConfig(settings, 'opencode', {
    cliPath: next.cliPath,
    discoveredModels: next.discoveredModels,
    enabled: next.enabled,
    environmentVariables: next.environmentVariables,
    prewarm: next.prewarm,
    visibleModels: next.visibleModels,
  });

  return next;
}
