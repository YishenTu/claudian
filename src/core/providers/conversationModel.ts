import type { Conversation } from '../types';
import { toProviderRuntimeModelId } from './modelSelection';
import { ProviderRegistry } from './ProviderRegistry';
import { ProviderSettingsCoordinator } from './ProviderSettingsCoordinator';
import type { ProviderId } from './types';

export type ConversationModelSource = 'selected' | 'usage' | 'default';

export interface ConversationModelResolution {
  model: string;
  source: ConversationModelSource;
  shouldPersist: boolean;
}

function trimModel(model: unknown): string {
  return typeof model === 'string' ? model.trim() : '';
}

function findModelOption(
  providerId: ProviderId,
  model: string,
  settings: Record<string, unknown>,
): string | null {
  const runtimeModel = toProviderRuntimeModelId(providerId, model);
  const option = ProviderRegistry
    .getChatUIConfig(providerId)
    .getModelOptions(settings)
    .find(candidate =>
      candidate.value === model
      || toProviderRuntimeModelId(providerId, candidate.value) === runtimeModel
    );
  return option?.value ?? null;
}

export function normalizeProviderModelSelection(
  providerId: ProviderId,
  settings: Record<string, unknown>,
  model: unknown,
): string | null {
  const rawModel = trimModel(model);
  if (!rawModel) {
    return null;
  }

  const uiConfig = ProviderRegistry.getChatUIConfig(providerId);
  const baseSettings = ProviderSettingsCoordinator.getProviderSettingsSnapshot(
    settings,
    providerId,
  );
  const rawSettings = {
    ...baseSettings,
    model: rawModel,
  };

  const rawOption = findModelOption(providerId, rawModel, rawSettings);
  if (rawOption) {
    return rawOption;
  }
  if (uiConfig.ownsModel(rawModel, rawSettings)) {
    return rawModel;
  }

  const normalizedModel = trimModel(uiConfig.normalizeModelVariant(rawModel, rawSettings));
  if (!normalizedModel) {
    return null;
  }

  const normalizedSettings = {
    ...baseSettings,
    model: normalizedModel,
  };
  const normalizedOption = findModelOption(providerId, normalizedModel, normalizedSettings);
  if (normalizedOption) {
    return normalizedOption;
  }

  return normalizedModel === rawModel && uiConfig.ownsModel(normalizedModel, normalizedSettings)
    ? normalizedModel
    : null;
}

export function resolveConversationModel(
  settings: Record<string, unknown>,
  providerId: ProviderId,
  conversation?: Conversation | null,
): ConversationModelResolution {
  const selectedModel = normalizeProviderModelSelection(
    providerId,
    settings,
    conversation?.selectedModel,
  );
  if (selectedModel) {
    return {
      model: selectedModel,
      source: 'selected',
      shouldPersist: selectedModel !== conversation?.selectedModel,
    };
  }

  const usageModel = normalizeProviderModelSelection(
    providerId,
    settings,
    conversation?.usage?.model,
  );
  if (usageModel) {
    return {
      model: usageModel,
      source: 'usage',
      shouldPersist: true,
    };
  }

  const providerSettings = ProviderSettingsCoordinator.getProviderSettingsSnapshot(
    settings,
    providerId,
  );
  const defaultModel = normalizeProviderModelSelection(
    providerId,
    settings,
    providerSettings.model,
  ) ?? trimModel(providerSettings.model);

  return {
    model: defaultModel,
    source: 'default',
    shouldPersist: false,
  };
}

export function getProviderSettingsSnapshotWithModel<T extends Record<string, unknown>>(
  settings: T,
  providerId: ProviderId,
  model?: string | null,
): T {
  const snapshot = ProviderSettingsCoordinator.getProviderSettingsSnapshot(
    settings,
    providerId,
  );
  const normalizedModel = normalizeProviderModelSelection(providerId, snapshot, model);
  if (normalizedModel) {
    ProviderSettingsCoordinator.projectModelSelection(snapshot, providerId, normalizedModel);
  }
  return snapshot;
}
