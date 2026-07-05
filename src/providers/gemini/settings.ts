import { getProviderConfig, setProviderConfig } from '../../core/providers/providerConfig';
import { getProviderEnvironmentVariables } from '../../core/providers/providerEnvironment';

export interface PersistedGeminiProviderSettings {
  enabled: boolean;
  environmentHash: string;
  environmentVariables: string;
  visibleModels: string[];
}

export type GeminiProviderSettings = PersistedGeminiProviderSettings;

export const DEFAULT_GEMINI_PROVIDER_SETTINGS: Readonly<PersistedGeminiProviderSettings> = Object.freeze({
  enabled: true,
  environmentHash: '',
  environmentVariables: '',
  visibleModels: ['gemini-1.5-pro', 'gemini-1.5-flash', 'gemini-2.0-flash-exp'],
});

function normalizeGeminiVisibleModels(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== 'string') continue;
    const trimmed = entry.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    normalized.push(trimmed);
  }
  return normalized;
}

export function getGeminiProviderSettings(settings: Record<string, unknown>): GeminiProviderSettings {
  const config = getProviderConfig(settings, 'gemini');

  return {
    enabled: (config.enabled as boolean | undefined) ?? DEFAULT_GEMINI_PROVIDER_SETTINGS.enabled,
    environmentHash: (config.environmentHash as string | undefined) ?? DEFAULT_GEMINI_PROVIDER_SETTINGS.environmentHash,
    environmentVariables: (config.environmentVariables as string | undefined) ?? getProviderEnvironmentVariables(settings, 'gemini') ?? DEFAULT_GEMINI_PROVIDER_SETTINGS.environmentVariables,
    visibleModels: normalizeGeminiVisibleModels(config.visibleModels).length > 0 
      ? normalizeGeminiVisibleModels(config.visibleModels) 
      : [...DEFAULT_GEMINI_PROVIDER_SETTINGS.visibleModels],
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
  });

  return next;
}
