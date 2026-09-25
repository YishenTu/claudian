import { getProviderSettingsSnapshotWithModel } from '../../core/providers/conversationModel';
import { ProviderRegistry } from '../../core/providers/ProviderRegistry';
import type { ProviderId } from '../../core/providers/types';

/** The model and reasoning selection displayed by a chat and submitted with its turns. */
export interface ChatSettings {
  model: string;
  reasoning: string | null;
  permissionMode: string;
  serviceTier: string;
}

export function getChatSettingsSnapshot<T extends Record<string, unknown>>(
  settings: T,
  providerId: ProviderId,
  model?: string | null,
): T & ChatSettings {
  const snapshot = getProviderSettingsSnapshotWithModel(settings, providerId, model);
  const selectedModel = typeof snapshot.model === 'string' ? snapshot.model : '';
  const ui = ProviderRegistry.getChatUIConfig(providerId);
  const options = ui.getReasoningOptions(selectedModel, snapshot);
  const selectedReasoning = ui.isAdaptiveReasoningModel(selectedModel, snapshot)
    ? snapshot.effortLevel
    : snapshot.thinkingBudget;
  // Native adapters validate explicit choices; never turn an unsupported choice into a native default.
  const reasoning = options.length > 0 && typeof selectedReasoning === 'string'
    ? selectedReasoning : null;
  return {
    ...snapshot,
    model: selectedModel,
    reasoning,
    permissionMode: typeof snapshot.permissionMode === 'string' ? snapshot.permissionMode : 'normal',
    serviceTier: typeof snapshot.serviceTier === 'string' ? snapshot.serviceTier : 'default',
  };
}
