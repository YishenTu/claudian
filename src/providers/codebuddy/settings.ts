import { getProviderConfig, setProviderConfig } from '../../core/providers/providerConfig';
import { getProviderEnvironmentVariables } from '../../core/providers/providerEnvironment';
import type { HostnameCliPaths } from '../../core/types/settings';
import {
  getHostnameKey,
  getLegacyHostnameKey,
  migrateLegacyHostnameKeyedMap,
} from '../../utils/env';
import {
  CODEBUDDY_DEFAULT_REASONING_LEVEL,
  type CodeBuddyDiscoveredModel,
  normalizeCodeBuddyDiscoveredModels,
  normalizeCodeBuddyVisibleModels,
} from './models';

export interface CodeBuddyProviderSettings {
  cliPath: string;
  cliPathsByHost: HostnameCliPaths;
  discoveredModels: CodeBuddyDiscoveredModel[];
  enabled: boolean;
  environmentHash: string;
  environmentVariables: string;
  modelAliases: Record<string, string>;
  preferredThinkingByModel: Record<string, string>;
  visibleModels: string[];
}

export const DEFAULT_CODEBUDDY_PROVIDER_SETTINGS: Readonly<CodeBuddyProviderSettings> = Object.freeze({
  cliPath: '',
  cliPathsByHost: {},
  discoveredModels: [],
  enabled: false,
  environmentHash: '',
  environmentVariables: '',
  modelAliases: {},
  preferredThinkingByModel: {},
  visibleModels: [],
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

function normalizeStringMap(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }

  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof key === 'string' && key.trim() && typeof entry === 'string' && entry.trim()) {
      result[key.trim()] = entry.trim();
    }
  }
  return result;
}

export function getCodeBuddyProviderSettings(settings: Record<string, unknown>): CodeBuddyProviderSettings {
  const config = getProviderConfig(settings, 'codebuddy');
  const normalizedCliPathsByHost = normalizeHostnameCliPaths(config.cliPathsByHost);
  const cliPathsByHost = Object.keys(normalizedCliPathsByHost).length > 0
    ? migrateLegacyHostnameKeyedMap(
      normalizedCliPathsByHost,
      getHostnameKey(),
      getLegacyHostnameKey(),
    )
    : normalizedCliPathsByHost;
  const discoveredModels = normalizeCodeBuddyDiscoveredModels(config.discoveredModels);

  return {
    cliPath: (config.cliPath as string | undefined) ?? DEFAULT_CODEBUDDY_PROVIDER_SETTINGS.cliPath,
    cliPathsByHost,
    discoveredModels,
    enabled: (config.enabled as boolean | undefined) ?? DEFAULT_CODEBUDDY_PROVIDER_SETTINGS.enabled,
    environmentHash: (config.environmentHash as string | undefined)
      ?? DEFAULT_CODEBUDDY_PROVIDER_SETTINGS.environmentHash,
    environmentVariables: (config.environmentVariables as string | undefined)
      ?? getProviderEnvironmentVariables(settings, 'codebuddy')
      ?? DEFAULT_CODEBUDDY_PROVIDER_SETTINGS.environmentVariables,
    modelAliases: normalizeStringMap(config.modelAliases),
    preferredThinkingByModel: normalizeStringMap(config.preferredThinkingByModel),
    visibleModels: normalizeCodeBuddyVisibleModels(config.visibleModels, discoveredModels),
  };
}

export function updateCodeBuddyProviderSettings(
  settings: Record<string, unknown>,
  updates: Partial<CodeBuddyProviderSettings>,
): CodeBuddyProviderSettings {
  const current = getCodeBuddyProviderSettings(settings);
  const hostnameKey = getHostnameKey();
  const nextDiscoveredModels = normalizeCodeBuddyDiscoveredModels(
    updates.discoveredModels ?? current.discoveredModels,
  );
  const nextVisibleModels = normalizeCodeBuddyVisibleModels(
    updates.visibleModels ?? current.visibleModels,
    nextDiscoveredModels,
  );
  const nextCliPathsByHost = 'cliPathsByHost' in updates
    ? normalizeHostnameCliPaths(updates.cliPathsByHost)
    : { ...current.cliPathsByHost };
  let nextCliPath = 'cliPathsByHost' in updates
    ? (typeof updates.cliPath === 'string' ? updates.cliPath.trim() : '')
    : current.cliPath.trim();

  if ('cliPath' in updates && !('cliPathsByHost' in updates)) {
    const trimmedCliPath = typeof updates.cliPath === 'string' ? updates.cliPath.trim() : '';
    if (trimmedCliPath) {
      nextCliPathsByHost[hostnameKey] = trimmedCliPath;
    } else {
      delete nextCliPathsByHost[hostnameKey];
    }
    nextCliPath = '';
  }

  const next: CodeBuddyProviderSettings = {
    ...current,
    ...updates,
    cliPath: nextCliPath,
    cliPathsByHost: nextCliPathsByHost,
    discoveredModels: nextDiscoveredModels,
    modelAliases: normalizeStringMap(updates.modelAliases ?? current.modelAliases),
    preferredThinkingByModel: normalizeStringMap(
      updates.preferredThinkingByModel ?? current.preferredThinkingByModel,
    ),
    visibleModels: nextVisibleModels,
  };

  setProviderConfig(settings, 'codebuddy', {
    cliPath: next.cliPath,
    cliPathsByHost: next.cliPathsByHost,
    discoveredModels: next.discoveredModels,
    enabled: next.enabled,
    environmentHash: next.environmentHash,
    environmentVariables: next.environmentVariables,
    modelAliases: next.modelAliases,
    preferredThinkingByModel: next.preferredThinkingByModel,
    visibleModels: next.visibleModels,
  });
  return next;
}

export function resolveCodeBuddyPreferredThinking(
  settings: CodeBuddyProviderSettings,
  rawModelId: string | null,
): string {
  return rawModelId
    ? settings.preferredThinkingByModel[rawModelId] ?? CODEBUDDY_DEFAULT_REASONING_LEVEL
    : CODEBUDDY_DEFAULT_REASONING_LEVEL;
}
