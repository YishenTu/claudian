import { getRuntimeEnvironmentVariables } from '../../core/providers/providerEnvironment';
import type { ProviderUIOption } from '../../core/providers/types';
import { getCursorProviderSettings } from './settings';
import {
  DEFAULT_CURSOR_MODEL_SET,
  DEFAULT_CURSOR_MODELS,
  DEFAULT_CURSOR_PRIMARY_MODEL,
  formatCursorModelLabel,
} from './types/models';

function createCustomCursorModelOption(modelId: string, description: string): ProviderUIOption {
  return {
    value: modelId,
    label: formatCursorModelLabel(modelId),
    description,
  };
}

function getConfiguredEnvModel(settings: Record<string, unknown>): string | null {
  const modelId = getRuntimeEnvironmentVariables(settings, 'cursor').CURSOR_MODEL?.trim();
  return modelId ? modelId : null;
}

export function getConfiguredEnvCustomModel(settings: Record<string, unknown>): string | null {
  const modelId = getConfiguredEnvModel(settings);
  return modelId && !DEFAULT_CURSOR_MODEL_SET.has(modelId) ? modelId : null;
}

export function parseConfiguredCustomModelIds(value: string): string[] {
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

export function getCursorModelOptions(settings: Record<string, unknown>): ProviderUIOption[] {
  const models = [...DEFAULT_CURSOR_MODELS];
  const seenValues = new Set(models.map(model => model.value));

  const envModel = getConfiguredEnvCustomModel(settings);
  if (envModel) {
    seenValues.add(envModel);
    models.unshift(createCustomCursorModelOption(envModel, 'Custom (env)'));
  }

  const cursorSettings = getCursorProviderSettings(settings);
  for (const modelId of parseConfiguredCustomModelIds(cursorSettings.customModels)) {
    if (seenValues.has(modelId)) {
      continue;
    }

    seenValues.add(modelId);
    models.push(createCustomCursorModelOption(modelId, 'Custom model'));
  }

  return models;
}

export function resolveCursorModelSelection(
  settings: Record<string, unknown>,
  currentModel: string,
): string | null {
  const envModel = getConfiguredEnvModel(settings);
  if (envModel) {
    return envModel;
  }

  const modelOptions = getCursorModelOptions(settings);
  if (currentModel && modelOptions.some(option => option.value === currentModel)) {
    return currentModel;
  }

  return modelOptions[0]?.value ?? DEFAULT_CURSOR_PRIMARY_MODEL;
}
