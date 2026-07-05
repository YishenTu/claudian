import { getProviderConfig, setProviderConfig } from '../../core/providers/providerConfig';
import { getProviderEnvironmentVariables } from '../../core/providers/providerEnvironment';

export interface PersistedGeminiProviderSettings {
  enabled: boolean;
  environmentHash: string;
  environmentVariables: string;
  visibleModels: string[];
  fetchedModels?: { id: string; label: string }[];
}

export type GeminiProviderSettings = PersistedGeminiProviderSettings;

export const DEFAULT_GEMINI_PROVIDER_SETTINGS: Readonly<PersistedGeminiProviderSettings> = Object.freeze({
  enabled: true,
  environmentHash: '',
  environmentVariables: '',
  visibleModels: ['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.0-flash'],
  fetchedModels: [],
});

// Google retired these model ids; remap stale persisted selections to live equivalents.
const LEGACY_GEMINI_MODEL_MAP: Record<string, string> = {
  'gemini-1.5-pro': 'gemini-2.5-pro',
  'gemini-1.5-pro-latest': 'gemini-2.5-pro',
  'gemini-1.5-pro-002': 'gemini-2.5-pro',
  'gemini-1.5-flash': 'gemini-2.5-flash',
  'gemini-1.5-flash-latest': 'gemini-2.5-flash',
  'gemini-1.5-flash-002': 'gemini-2.5-flash',
  'gemini-2.0-flash-exp': 'gemini-2.0-flash',
  'gemini-2.0-pro-exp': 'gemini-2.5-pro',
  'gemini-exp-1206': 'gemini-2.5-pro',
};

export function migrateLegacyGeminiModelId(model: string): string {
  return LEGACY_GEMINI_MODEL_MAP[model] ?? model;
}

function normalizeGeminiVisibleModels(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== 'string') continue;
    const trimmed = migrateLegacyGeminiModelId(entry.trim());
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    normalized.push(trimmed);
  }
  return normalized;
}

export function getGeminiProviderSettings(settings: Record<string, unknown> | undefined | null): GeminiProviderSettings {
  if (!settings) {
    return {
      enabled: DEFAULT_GEMINI_PROVIDER_SETTINGS.enabled,
      environmentHash: DEFAULT_GEMINI_PROVIDER_SETTINGS.environmentHash,
      environmentVariables: DEFAULT_GEMINI_PROVIDER_SETTINGS.environmentVariables,
      visibleModels: [...DEFAULT_GEMINI_PROVIDER_SETTINGS.visibleModels],
      fetchedModels: [...(DEFAULT_GEMINI_PROVIDER_SETTINGS.fetchedModels || [])],
    };
  }
  const config = getProviderConfig(settings, 'gemini');

  return {
    enabled: (config.enabled as boolean | undefined) ?? DEFAULT_GEMINI_PROVIDER_SETTINGS.enabled,
    environmentHash: (config.environmentHash as string | undefined) ?? DEFAULT_GEMINI_PROVIDER_SETTINGS.environmentHash,
    environmentVariables: (config.environmentVariables as string | undefined) ?? getProviderEnvironmentVariables(settings, 'gemini') ?? DEFAULT_GEMINI_PROVIDER_SETTINGS.environmentVariables,
    visibleModels: normalizeGeminiVisibleModels(config.visibleModels).length > 0 
      ? normalizeGeminiVisibleModels(config.visibleModels) 
      : [...DEFAULT_GEMINI_PROVIDER_SETTINGS.visibleModels],
    fetchedModels: Array.isArray(config.fetchedModels) 
      ? config.fetchedModels as { id: string; label: string }[] 
      : [...(DEFAULT_GEMINI_PROVIDER_SETTINGS.fetchedModels || [])],
  };
}

export function updateGeminiProviderSettings(
  settings: Record<string, unknown>,
  updates: Partial<GeminiProviderSettings>,
): GeminiProviderSettings {
  const current = getGeminiProviderSettings(settings);
  const nextVisibleModels = updates.visibleModels 
    ? normalizeGeminiVisibleModels(updates.visibleModels) 
    : current.visibleModels;

  const next: GeminiProviderSettings = {
    ...current,
    ...updates,
    visibleModels: nextVisibleModels.length > 0 ? nextVisibleModels : [...DEFAULT_GEMINI_PROVIDER_SETTINGS.visibleModels],
  };

  setProviderConfig(settings, 'gemini', {
    enabled: next.enabled,
    environmentHash: next.environmentHash,
    environmentVariables: next.environmentVariables,
    visibleModels: next.visibleModels,
    fetchedModels: next.fetchedModels,
  });

  return next;
}
