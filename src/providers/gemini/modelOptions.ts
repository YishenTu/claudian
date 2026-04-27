import { getRuntimeEnvironmentVariables } from '../../core/providers/providerEnvironment';
import type { ProviderUIOption } from '../../core/providers/types';
import { getGeminiProviderSettings } from './settings';
import {
  DEFAULT_GEMINI_MODEL_SET,
  DEFAULT_GEMINI_MODELS,
  DEFAULT_GEMINI_PRIMARY_MODEL,
  formatGeminiModelLabel,
} from './types/models';

function createCustomGeminiModelOption(modelId: string, description: string): ProviderUIOption {
  return {
    value: modelId,
    label: formatGeminiModelLabel(modelId),
    description,
  };
}

function getConfiguredEnvModel(settings: Record<string, unknown>): string | null {
  const env = getRuntimeEnvironmentVariables(settings, 'gemini');
  const modelId = env.GEMINI_MODEL?.trim() || env.GOOGLE_GEMINI_MODEL?.trim();
  return modelId ? modelId : null;
}

export function getConfiguredEnvCustomGeminiModel(settings: Record<string, unknown>): string | null {
  const modelId = getConfiguredEnvModel(settings);
  return modelId && !DEFAULT_GEMINI_MODEL_SET.has(modelId) ? modelId : null;
}

export function parseConfiguredCustomGeminiModelIds(value: string): string[] {
  const modelIds: string[] = [];
  const seen = new Set<string>();

  for (const line of value.split(/\r?\n/)) {
    const modelId = line.trim();
    if (!modelId || seen.has(modelId)) {
      continue;
    }

    seen.add(modelId);
    modelIds.push(modelId);
  }

  return modelIds;
}

export function getGeminiModelOptions(settings: Record<string, unknown>): ProviderUIOption[] {
  const models = [...DEFAULT_GEMINI_MODELS];
  const seenValues = new Set(models.map(model => model.value));

  const envModel = getConfiguredEnvCustomGeminiModel(settings);
  if (envModel) {
    seenValues.add(envModel);
    models.unshift(createCustomGeminiModelOption(envModel, 'Custom (env)'));
  }

  const geminiSettings = getGeminiProviderSettings(settings);
  for (const modelId of parseConfiguredCustomGeminiModelIds(geminiSettings.customModels)) {
    if (seenValues.has(modelId)) {
      continue;
    }

    seenValues.add(modelId);
    models.push(createCustomGeminiModelOption(modelId, 'Custom model'));
  }

  return models;
}

export function resolveGeminiModelSelection(
  settings: Record<string, unknown>,
  currentModel: string,
): string | null {
  const envModel = getConfiguredEnvModel(settings);
  if (envModel) {
    return envModel;
  }

  const modelOptions = getGeminiModelOptions(settings);
  if (currentModel && modelOptions.some(option => option.value === currentModel)) {
    return currentModel;
  }

  return modelOptions[0]?.value ?? DEFAULT_GEMINI_PRIMARY_MODEL;
}
