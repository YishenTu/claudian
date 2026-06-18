import { getRuntimeEnvironmentVariables } from '../../core/providers/providerEnvironment';
import type { ProviderUIOption } from '../../core/providers/types';
import { encodeCodexModelSelectionId, toCodexRuntimeModelId } from './modelSelection';
import { getCodexProviderSettings } from './settings';
import {
  DEFAULT_CODEX_MODEL_SET,
  DEFAULT_CODEX_MODELS,
  DEFAULT_CODEX_PRIMARY_MODEL,
  formatCodexModelLabel,
} from './types/models';

function createCustomCodexModelOption(modelId: string, description: string): ProviderUIOption {
  const runtimeModelId = toCodexRuntimeModelId(modelId);
  return {
    value: encodeCodexModelSelectionId(runtimeModelId),
    label: formatCodexModelLabel(runtimeModelId),
    description,
  };
}

function getConfiguredEnvModel(settings: Record<string, unknown>): string | null {
  const modelId = getRuntimeEnvironmentVariables(settings, 'codex').OPENAI_MODEL?.trim();
  return modelId ? modelId : null;
}

export function getConfiguredEnvCustomModel(settings: Record<string, unknown>): string | null {
  const modelId = getConfiguredEnvModel(settings);
  return modelId && !DEFAULT_CODEX_MODEL_SET.has(modelId) ? modelId : null;
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

export function getCodexModelOptions(settings: Record<string, unknown>): ProviderUIOption[] {
  const models = [...DEFAULT_CODEX_MODELS];
  const seenModelIds = new Set(models.map(model => toCodexRuntimeModelId(model.value)));

  const envModel = getConfiguredEnvCustomModel(settings);
  if (envModel) {
    seenModelIds.add(envModel);
    models.unshift(createCustomCodexModelOption(envModel, 'Custom (env)'));
  }

  const codexSettings = getCodexProviderSettings(settings);
  for (const configuredModelId of parseConfiguredCustomModelIds(codexSettings.customModels)) {
    const modelId = toCodexRuntimeModelId(configuredModelId);
    if (seenModelIds.has(modelId)) {
      continue;
    }

    seenModelIds.add(modelId);
    models.push(createCustomCodexModelOption(modelId, 'Custom model'));
  }

  return models;
}

export function resolveCodexModelSelection(
  settings: Record<string, unknown>,
  currentModel: string,
): string | null {
  const modelOptions = getCodexModelOptions(settings);
  const envModel = getConfiguredEnvModel(settings);
  if (envModel) {
    const envRuntimeModel = toCodexRuntimeModelId(envModel);
    const envOption = modelOptions.find(option =>
      option.value === envModel
      || toCodexRuntimeModelId(option.value) === envRuntimeModel
    );
    return envOption?.value ?? envModel;
  }

  if (currentModel) {
    const currentRuntimeModel = toCodexRuntimeModelId(currentModel);
    const currentOption = modelOptions.find(option =>
      option.value === currentModel
      || toCodexRuntimeModelId(option.value) === currentRuntimeModel
    );
    if (currentOption) {
      return currentOption.value;
    }
  }

  return modelOptions[0]?.value ?? DEFAULT_CODEX_PRIMARY_MODEL;
}
