import { getProviderConfig, setProviderConfig } from '../../core/providers/providerConfig';
import { getProviderEnvironmentVariables } from '../../core/providers/providerEnvironment';
import {
  normalizeOpencodeDiscoveredModels,
  type OpencodeDiscoveredModel,
  resolveOpencodeBaseModelRawId,
} from './models';

export interface OpencodeProviderSettings {
  cliPath: string;
  discoveredModels: OpencodeDiscoveredModel[];
  enabled: boolean;
  environmentVariables: string;
  prewarm: boolean;
  preferredThinkingByModel: Record<string, string>;
  visibleModels: string[];
}

export const DEFAULT_OPENCODE_PROVIDER_SETTINGS: Readonly<OpencodeProviderSettings> = Object.freeze({
  cliPath: '',
  discoveredModels: [],
  enabled: false,
  environmentVariables: '',
  prewarm: true,
  preferredThinkingByModel: {},
  visibleModels: [],
});

export function normalizeOpencodeVisibleModels(
  value: unknown,
  discoveredModels: OpencodeDiscoveredModel[] = [],
): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== 'string') {
      continue;
    }

    const trimmed = resolveOpencodeBaseModelRawId(entry.trim(), discoveredModels);
    if (!trimmed || seen.has(trimmed)) {
      continue;
    }

    seen.add(trimmed);
    normalized.push(trimmed);
  }

  return normalized;
}

export function normalizeOpencodePreferredThinkingByModel(
  value: unknown,
  discoveredModels: OpencodeDiscoveredModel[] = [],
): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }

  const normalized: Record<string, string> = {};
  for (const [rawId, thinkingLevel] of Object.entries(value as Record<string, unknown>)) {
    if (typeof thinkingLevel !== 'string') {
      continue;
    }

    const normalizedRawId = resolveOpencodeBaseModelRawId(rawId.trim(), discoveredModels);
    const normalizedThinkingLevel = thinkingLevel.trim();
    if (!normalizedRawId || !normalizedThinkingLevel) {
      continue;
    }

    normalized[normalizedRawId] = normalizedThinkingLevel;
  }

  return normalized;
}

export function getOpencodeProviderSettings(
  settings: Record<string, unknown>,
): OpencodeProviderSettings {
  const config = getProviderConfig(settings, 'opencode');
  const discoveredModels = normalizeOpencodeDiscoveredModels(config.discoveredModels);
  return {
    cliPath: (config.cliPath as string | undefined)
      ?? DEFAULT_OPENCODE_PROVIDER_SETTINGS.cliPath,
    discoveredModels,
    enabled: (config.enabled as boolean | undefined)
      ?? DEFAULT_OPENCODE_PROVIDER_SETTINGS.enabled,
    environmentVariables: (config.environmentVariables as string | undefined)
      ?? getProviderEnvironmentVariables(settings, 'opencode')
      ?? DEFAULT_OPENCODE_PROVIDER_SETTINGS.environmentVariables,
    prewarm: (config.prewarm as boolean | undefined)
      ?? DEFAULT_OPENCODE_PROVIDER_SETTINGS.prewarm,
    preferredThinkingByModel: normalizeOpencodePreferredThinkingByModel(
      config.preferredThinkingByModel,
      discoveredModels,
    ),
    visibleModels: normalizeOpencodeVisibleModels(config.visibleModels, discoveredModels),
  };
}

export function updateOpencodeProviderSettings(
  settings: Record<string, unknown>,
  updates: Partial<OpencodeProviderSettings>,
): OpencodeProviderSettings {
  const current = getOpencodeProviderSettings(settings);
  const next: OpencodeProviderSettings = {
    ...current,
    ...updates,
    discoveredModels: normalizeOpencodeDiscoveredModels(
      updates.discoveredModels ?? current.discoveredModels,
    ),
    preferredThinkingByModel: normalizeOpencodePreferredThinkingByModel(
      updates.preferredThinkingByModel ?? current.preferredThinkingByModel,
      normalizeOpencodeDiscoveredModels(updates.discoveredModels ?? current.discoveredModels),
    ),
    visibleModels: normalizeOpencodeVisibleModels(
      updates.visibleModels ?? current.visibleModels,
      normalizeOpencodeDiscoveredModels(updates.discoveredModels ?? current.discoveredModels),
    ),
  };

  setProviderConfig(settings, 'opencode', {
    cliPath: next.cliPath,
    discoveredModels: next.discoveredModels,
    enabled: next.enabled,
    environmentVariables: next.environmentVariables,
    prewarm: next.prewarm,
    preferredThinkingByModel: next.preferredThinkingByModel,
    visibleModels: next.visibleModels,
  });

  return next;
}
