import { getRuntimeEnvironmentVariables } from '../../core/providers/providerEnvironment';
import type { ProviderUIOption } from '../../core/providers/types';
import { getCodexModelsInPickerOrder, getDefaultCodexModel } from './models';
import {
  encodeCodexModelSelectionId,
  isCodexModelSelectionId,
  looksLikeCodexModel,
  toCodexRuntimeModelId,
} from './modelSelection';
import { getCodexProviderSettings, getVisibleCodexModelIds } from './settings';
import { formatCodexModelLabel } from './types/models';

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
  const discoveredModels = getCodexProviderSettings(settings).discoveredModels;
  return modelId && !discoveredModels.some(model => model.model === modelId) ? modelId : null;
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
  const codexSettings = getCodexProviderSettings(settings);
  const visibleModelIds = new Set(getVisibleCodexModelIds(
    codexSettings.visibleModels,
    codexSettings.discoveredModels,
  ));
  const savedProviderModel = (
    settings.savedProviderModel
    && typeof settings.savedProviderModel === 'object'
    && !Array.isArray(settings.savedProviderModel)
  )
    ? settings.savedProviderModel as Record<string, unknown>
    : null;
  const pinnedModelIds = new Set<string>();
  for (const value of [
    settings.model,
    savedProviderModel?.codex,
    getConfiguredEnvModel(settings),
  ]) {
    if (typeof value === 'string' && value.trim()) {
      pinnedModelIds.add(toCodexRuntimeModelId(value));
    }
  }
  const absentPinnedSelections: string[] = [];
  const currentModel = typeof settings.model === 'string' ? settings.model.trim() : '';
  if (
    codexSettings.discoveredModels.length === 0
    && currentModel
    && (
      isCodexModelSelectionId(currentModel)
      || looksLikeCodexModel(toCodexRuntimeModelId(currentModel))
    )
  ) {
    absentPinnedSelections.push(currentModel);
  }
  const savedCodexModel = typeof savedProviderModel?.codex === 'string'
    ? savedProviderModel.codex.trim()
    : '';
  if (codexSettings.discoveredModels.length === 0 && savedCodexModel) {
    absentPinnedSelections.push(savedCodexModel);
  }

  const pickerOrderedModels = getCodexModelsInPickerOrder(codexSettings.discoveredModels);
  const visibleDiscoveredModels = pickerOrderedModels
    .filter(model => visibleModelIds.has(model.model));
  const pinnedDiscoveredModels = pickerOrderedModels.filter(model =>
    !visibleModelIds.has(model.model) && pinnedModelIds.has(model.model)
  );
  const models: ProviderUIOption[] = visibleDiscoveredModels.map(model => ({
    value: model.model,
    label: model.displayName,
    description: model.description || undefined,
  }));
  const seenModelIds = new Set(visibleDiscoveredModels.map(model => model.model));

  const persistedVisibleModels = codexSettings.visibleModels === null
    ? []
    : [...codexSettings.visibleModels].reverse();
  for (const modelId of persistedVisibleModels) {
    if (seenModelIds.has(modelId)) {
      continue;
    }

    seenModelIds.add(modelId);
    models.push({
      value: modelId,
      label: formatCodexModelLabel(modelId),
      description: 'Selected model',
    });
  }

  for (const model of pinnedDiscoveredModels) {
    seenModelIds.add(model.model);
    models.push({
      value: model.model,
      label: model.displayName,
      description: model.description || undefined,
    });
  }

  for (const selection of absentPinnedSelections) {
    const modelId = toCodexRuntimeModelId(selection);
    if (seenModelIds.has(modelId)) {
      continue;
    }

    seenModelIds.add(modelId);
    models.push(
      isCodexModelSelectionId(selection) || !looksLikeCodexModel(modelId)
        ? createCustomCodexModelOption(modelId, 'Selected model')
        : {
          value: modelId,
          label: formatCodexModelLabel(modelId),
          description: 'Selected model',
        },
    );
  }

  const envModel = getConfiguredEnvCustomModel(settings);
  if (envModel) {
    const runtimeModelId = toCodexRuntimeModelId(envModel);
    const existingIndex = models.findIndex(option =>
      toCodexRuntimeModelId(option.value) === runtimeModelId
    );
    if (existingIndex >= 0) {
      models.splice(existingIndex, 1);
    }
    seenModelIds.add(runtimeModelId);
    models.unshift(createCustomCodexModelOption(envModel, 'Custom (env)'));
  }

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

  const codexSettings = getCodexProviderSettings(settings);
  const visibleModelIds = new Set(getVisibleCodexModelIds(
    codexSettings.visibleModels,
    codexSettings.discoveredModels,
  ));
  const defaultModel = getDefaultCodexModel(
    codexSettings.discoveredModels.filter(model => visibleModelIds.has(model.model)),
  );
  return defaultModel?.model ?? modelOptions[0]?.value ?? null;
}
