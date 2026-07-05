import type { ProviderSettingsReconciler } from '../../../core/providers/types';
import type { Conversation } from '../../../core/types';

export const geminiSettingsReconciler: ProviderSettingsReconciler = {
  handleEnvironmentChange: (_settings: Record<string, unknown>) => {
    return false;
  },

  reconcileModelWithEnvironment: (
    _settings: Record<string, unknown>,
    _conversations: Conversation[],
  ) => {
    return { changed: false, invalidatedConversations: [] };
  },

  normalizeModelVariantSettings: (_settings: Record<string, unknown>) => {
    return false;
  },
};
