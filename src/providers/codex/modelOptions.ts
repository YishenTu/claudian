import type { ProviderUIOption } from '../../core/providers/types';
import { type CodexProviderSettings, getVisibleCodexModelIds } from './config';
import { isCodexModelAvailable } from './models';
import {
  encodeCodexModelSelectionId, toCodexRuntimeModelId
} from './modelSelection';

type CodexModelOptionSettings = Pick<
  CodexProviderSettings,
  'discoveredModels' | 'enableUltraEffort' | 'modelAliases' | 'visibleModels'
>;

export function getCodexModelOptions(codexSettings: CodexModelOptionSettings): ProviderUIOption[] {
  const getModelLabel = (modelId: string, fallback: string): string => {
    return Object.prototype.hasOwnProperty.call(codexSettings.modelAliases, modelId)
      ? codexSettings.modelAliases[modelId]
      : fallback;
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
  const visibleDiscoveredModels = visibleModelIds
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
  codexSettings: CodexModelOptionSettings,
  currentModel: string,
): string | null {
  const modelOptions = getCodexModelOptions(codexSettings);
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
