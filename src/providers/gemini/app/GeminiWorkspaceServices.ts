import type {
  ProviderWorkspaceRegistration,
  ProviderWorkspaceServices,
} from '../../../core/providers/types';
import { geminiSettingsTabRenderer } from '../ui/GeminiSettingsTab';

export type GeminiWorkspaceServices = ProviderWorkspaceServices;

export const geminiWorkspaceRegistration: ProviderWorkspaceRegistration<GeminiWorkspaceServices> = {
  initialize: async () => ({
    settingsTabRenderer: geminiSettingsTabRenderer,
  }),
};
