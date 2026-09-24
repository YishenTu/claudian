import type { ProviderUIOption } from '../../core/providers/types';
import { isCodexModelAvailable } from './models';
import {
  encodeCodexModelSelectionId, toCodexRuntimeModelId
} from './modelSelection';
import { getCodexProviderSettings, getVisibleCodexModelIds } from './settings';

export function getCodexModelOptions(settings: Record<string, unknown>): ProviderUIOption[] {
  const codexSettings = getCodexProviderSettings(settings);
  const getModelLabel = (modelId: string, fallback: string): string => {
    return codexSettings.modelAliases[modelId] ?? fallback;
  };
  const visibleModelIds = getVisibleCodexModelIds(
    codexSettings.visibleModels,
    codexSettings.discoveredModels,
  );
  const visibleModelIdSet = new Set(visibleModelIds);
  const discoveredModelsById = new Map(codexSettings.discoveredModels.map(model => [
    model.model,
    model,
  ] as const));
  const visibleDiscoveredModels = [...visibleModelIds]
    .reverse()
    .map(modelId => discoveredModelsById.get(modelId))
    .filter((model): model is NonNullable<typeof model> => Boolean(
      model
      && visibleModelIdSet.has(model.model)
      && isCodexModelAvailable(model, codexSettings.enableUltraEffort),
    ));
  const models: ProviderUIOption[] = visibleDiscoveredModels.map(model => ({
    value: encodeCodexModelSelectionId(model.model),
    label: getModelLabel(model.model, model.displayName),
    description: model.description || undefined,
  }));

  return models;
}

export function resolveCodexModelSelection(
  settings: Record<string, unknown>,
  currentModel: string,
): string | null {
  const codexSettings = getCodexProviderSettings(settings);
  const modelOptions = getCodexModelOptions(settings);
  if (currentModel) {
    const currentRuntimeModel = toCodexRuntimeModelId(currentModel);
    return modelOptions.find(option => toCodexRuntimeModelId(option.value) === currentRuntimeModel)?.value ?? currentModel;
  }

  const visibleModelIds = getVisibleCodexModelIds(
    codexSettings.visibleModels,
    codexSettings.discoveredModels,
  );
  const firstVisibleModelId = visibleModelIds.find(modelId => {
    const model = codexSettings.discoveredModels.find(candidate => candidate.model === modelId);
    return model && isCodexModelAvailable(model, codexSettings.enableUltraEffort);
  });
  return firstVisibleModelId ? encodeCodexModelSelectionId(firstVisibleModelId) : modelOptions[0]?.value ?? null;
}
