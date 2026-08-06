import type { Conversation } from '../types';
import type { StoredChatModelSelection } from '../types/settings';
import { toProviderRuntimeModelId } from './modelSelection';
import { ProviderRegistry } from './ProviderRegistry';
import { ProviderSettingsCoordinator } from './ProviderSettingsCoordinator';
import type { ProviderId } from './types';

export type ConversationModelSource = 'selected' | 'usage' | 'default';

export interface ConversationModelResolution {
  model: string;
  /** Durable replacement required before readers may use it instead of `model`. */
  modelToPersist?: string;
  source: ConversationModelSource;
  shouldPersist: boolean;
}

export function getConversationModelPersistenceTarget(
  resolution: ConversationModelResolution,
): string {
  return resolution.modelToPersist ?? resolution.model;
}

export type NewConversationModelSource =
  | 'last-selected'
  | 'provider-default'
  | 'provider-fallback';

export interface NewConversationModelResolution extends StoredChatModelSelection {
  source: NewConversationModelSource;
}

function trimModel(model: unknown): string {
  return typeof model === 'string' ? model.trim() : '';
}

export function findProviderModelOption(
  providerId: ProviderId,
  model: string,
  settings: Record<string, unknown>,
): string | null {
  const uiConfig = ProviderRegistry.getChatUIConfig(providerId);
  const options = uiConfig.getModelOptions(settings);
  const findOption = (candidateModel: string): string | null => {
    const runtimeModel = toProviderRuntimeModelId(providerId, candidateModel);
    const option = options.find(candidate =>
      candidate.value === candidateModel
      || toProviderRuntimeModelId(providerId, candidate.value) === runtimeModel
    );
    return option?.value ?? null;
  };
  const exactOption = findOption(model);
  if (exactOption) {
    return exactOption;
  }

  const normalizedModel = trimModel(uiConfig.normalizeAvailableModelSelection?.(model, {
    ...settings,
    model,
  }));
  return normalizedModel && normalizedModel !== model
    ? findOption(normalizedModel)
    : null;
}

export function resolveProviderDefaultModel(
  providerId: ProviderId,
  settings: Record<string, unknown>,
): string | null {
  const uiConfig = ProviderRegistry.getChatUIConfig(providerId);
  const options = uiConfig.getModelOptions(settings);
  if (options.length === 0) {
    return null;
  }

  const preferred = trimModel(uiConfig.getDefaultModel?.(settings));
  if (preferred) {
    const preferredRuntimeModel = toProviderRuntimeModelId(providerId, preferred);
    const option = options.find(candidate => (
      candidate.value === preferred
      || toProviderRuntimeModelId(providerId, candidate.value) === preferredRuntimeModel
    ));
    if (option) {
      return option.value;
    }
  }

  return options[0]?.value ?? null;
}

function readStoredChatModelSelection(value: unknown): StoredChatModelSelection | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  const candidate = value as Record<string, unknown>;
  const providerId = trimModel(candidate.providerId);
  const model = trimModel(candidate.model);
  return providerId && model ? { providerId, model } : null;
}

export function resolveNewConversationModel(
  settings: Record<string, unknown>,
): NewConversationModelResolution | null {
  const registeredProviderIds = new Set(ProviderRegistry.getRegisteredProviderIds());
  const lastSelected = readStoredChatModelSelection(settings.lastSelectedChatModel);
  if (
    lastSelected
    && registeredProviderIds.has(lastSelected.providerId)
    && ProviderRegistry.isEnabled(lastSelected.providerId, settings)
  ) {
    const selectedModel = findProviderModelOption(
      lastSelected.providerId,
      lastSelected.model,
      settings,
    );
    if (selectedModel) {
      return {
        providerId: lastSelected.providerId,
        model: selectedModel,
        source: 'last-selected',
      };
    }

    const providerDefault = resolveProviderDefaultModel(lastSelected.providerId, settings);
    if (providerDefault) {
      return {
        providerId: lastSelected.providerId,
        model: providerDefault,
        source: 'provider-default',
      };
    }
  }

  for (const providerId of ProviderRegistry.getBlankTabProviderIds(settings)) {
    const providerDefault = resolveProviderDefaultModel(providerId, settings);
    if (providerDefault) {
      return {
        providerId,
        model: providerDefault,
        source: 'provider-fallback',
      };
    }
  }

  return null;
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

  const rawOption = findProviderModelOption(providerId, rawModel, rawSettings);
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
  const normalizedOption = findProviderModelOption(providerId, normalizedModel, normalizedSettings);
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
  const rawSelectedModel = trimModel(conversation?.selectedModel);
  const modelOptions = ProviderRegistry.getChatUIConfig(providerId).getModelOptions(settings);
  const selectedModel = rawSelectedModel
    ? findProviderModelOption(providerId, rawSelectedModel, settings)
    : null;
  if (selectedModel) {
    return {
      model: selectedModel,
      source: 'selected',
      shouldPersist: selectedModel !== rawSelectedModel,
    };
  }

  if (rawSelectedModel) {
    if (modelOptions.length === 0) {
      return {
        model: rawSelectedModel,
        source: 'selected',
        shouldPersist: false,
      };
    }

    const providerDefault = resolveProviderDefaultModel(providerId, settings);
    return {
      model: rawSelectedModel,
      ...(providerDefault ? { modelToPersist: providerDefault } : {}),
      source: 'selected',
      shouldPersist: Boolean(providerDefault && providerDefault !== rawSelectedModel),
    };
  }

  const rawUsageModel = trimModel(conversation?.usage?.model);
  if (rawUsageModel) {
    const usageModel = findProviderModelOption(providerId, rawUsageModel, settings)
      ?? (modelOptions.length === 0
        ? normalizeProviderModelSelection(providerId, settings, rawUsageModel)
        : null);
    if (usageModel) {
      return {
        model: usageModel,
        source: 'usage',
        shouldPersist: true,
      };
    }

    const usageFallback = resolveProviderDefaultModel(providerId, settings);
    if (usageFallback) {
      return {
        model: usageFallback,
        source: 'usage',
        shouldPersist: true,
      };
    }
  }

  const providerDefault = resolveProviderDefaultModel(providerId, settings);
  const providerSettings = providerDefault
    ? null
    : ProviderSettingsCoordinator.getProviderSettingsSnapshot(settings, providerId);
  const defaultModel = providerDefault ?? trimModel(providerSettings?.model);

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
