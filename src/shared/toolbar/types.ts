import type { ProviderCapabilities, ProviderChatUIConfig } from '@/core/providers/types';

/** The model and reasoning a model picker displays; its owner decides where changes apply. */
export interface ModelPickerSettings extends Record<string, unknown> {
  model: string;
  reasoning: string | null;
}

export interface ModelPickerCallbacks {
  onModelChange: (model: string) => Promise<void>;
  onEffortLevelChange: (effort: string) => Promise<void>;
  getSettings: () => ModelPickerSettings;
  getEnvironmentVariables?: () => string;
  getUIConfig: () => ProviderChatUIConfig;
  getCapabilities: () => ProviderCapabilities;
}
