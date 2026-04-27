import { getProviderConfig, setProviderConfig } from '../../core/providers/providerConfig';
import { getProviderEnvironmentVariables } from '../../core/providers/providerEnvironment';

export interface GeminiProviderSettings {
  enabled: boolean;
  customModels: string;
  environmentVariables: string;
  environmentHash: string;
  temperature: number;
}

export const DEFAULT_GEMINI_PROVIDER_SETTINGS: Readonly<GeminiProviderSettings> = Object.freeze({
  enabled: false,
  customModels: '',
  environmentVariables: '',
  environmentHash: '',
  temperature: 1.0,
});

function normalizeTemperature(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return DEFAULT_GEMINI_PROVIDER_SETTINGS.temperature;
  }
  return Math.max(0, Math.min(2, value));
}

export function getGeminiProviderSettings(
  settings: Record<string, unknown>,
): GeminiProviderSettings {
  const config = getProviderConfig(settings, 'gemini');
  return {
    enabled: (config.enabled as boolean | undefined)
      ?? DEFAULT_GEMINI_PROVIDER_SETTINGS.enabled,
    customModels: (config.customModels as string | undefined)
      ?? DEFAULT_GEMINI_PROVIDER_SETTINGS.customModels,
    environmentVariables: (config.environmentVariables as string | undefined)
      ?? getProviderEnvironmentVariables(settings, 'gemini')
      ?? DEFAULT_GEMINI_PROVIDER_SETTINGS.environmentVariables,
    environmentHash: (config.environmentHash as string | undefined)
      ?? DEFAULT_GEMINI_PROVIDER_SETTINGS.environmentHash,
    temperature: normalizeTemperature(
      config.temperature ?? DEFAULT_GEMINI_PROVIDER_SETTINGS.temperature,
    ),
  };
}

export function updateGeminiProviderSettings(
  settings: Record<string, unknown>,
  updates: Partial<GeminiProviderSettings>,
): GeminiProviderSettings {
  const next: GeminiProviderSettings = {
    ...getGeminiProviderSettings(settings),
    ...updates,
  };

  setProviderConfig(settings, 'gemini', {
    enabled: next.enabled,
    customModels: next.customModels,
    environmentVariables: next.environmentVariables,
    environmentHash: next.environmentHash,
    temperature: normalizeTemperature(next.temperature),
  });

  return next;
}
