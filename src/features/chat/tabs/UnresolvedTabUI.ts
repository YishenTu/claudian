import type { ProviderCapabilities, ProviderChatUIConfig } from '../../../core/providers/types';

/** Presentation only: an unresolved tab owns no provider or execution capabilities. */
export const UNRESOLVED_TAB_CAPABILITIES: ProviderCapabilities = {
  providerId: '',
  supportsNativeHistory: false,
  supportsEphemeralSessions: false,
  supportsRewind: false,
  supportsFork: false,
  supportsProviderCommands: false,
  supportsImageAttachments: false,
  reasoningControl: 'none',
};

export const UNRESOLVED_TAB_UI: ProviderChatUIConfig = {
  getModelOptions: () => [],
  ownsModel: () => false,
  isAdaptiveReasoningModel: () => false,
  getReasoningOptions: () => [],
  getDefaultReasoningValue: () => 'off',
  isDefaultModel: () => false,
  applyModelDefaults: () => {},
  normalizeModelVariant: model => model,
  getCustomModelIds: () => new Set(),
};
