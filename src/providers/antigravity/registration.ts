import { NOOP_TASK_RESULT_INTERPRETER } from '../../core/providers/NoopTaskResultInterpreter';
import { getProviderConfig } from '../../core/providers/providerConfig';
import { hasStoredConfigNormalization } from '../../core/providers/settings/storedSettings';
import type { ProviderModule } from '../../core/providers/types';
import { antigravityModelPolicy } from './AntigravityModelPolicy';
import {
  antigravityWorkspaceRegistration,
  getAntigravityWorkspaceServices,
} from './app/AntigravityWorkspaceServices';
import { ANTIGRAVITY_PROVIDER_CAPABILITIES } from './capabilities';
import { getAntigravityMigratedVisibleModelIds } from './config';
import { antigravitySettingsReconciler } from './env/AntigravitySettingsReconciler';
import { AntigravityExecutionBackend } from './execution/AntigravityExecutionBackend';
import { AntigravityConversationHistoryService } from './history/AntigravityConversationHistoryService';
import {
  ANTIGRAVITY_PROVIDER_ID,
  getAntigravityProviderSettings,
  projectAntigravityModelSettings,
  updateAntigravityProviderSettings,
} from './settings';
import { antigravityChatUIConfig } from './ui/AntigravityChatUIConfig';

export const antigravityProviderRegistration: ProviderModule = {
  id: ANTIGRAVITY_PROVIDER_ID,
  blankTabOrder: 14,
  capabilities: ANTIGRAVITY_PROVIDER_CAPABILITIES,
  chatUIConfig: antigravityChatUIConfig,
  createExecutionBackend: plugin => new AntigravityExecutionBackend(plugin.getRuntimeHost(ANTIGRAVITY_PROVIDER_ID), {
    modelSink: getAntigravityWorkspaceServices().modelCatalogOwner,
  }),
  displayName: 'Antigravity',
  environmentKeyPatterns: [/^AGY_/i, /^ANTIGRAVITY_/i, /^GEMINI_/i],
  historyService: new AntigravityConversationHistoryService(),
  isEnabled: settings => getAntigravityProviderSettings(settings).enabled,
  modelPolicy: antigravityModelPolicy,
  setEnabled: (settings, enabled) => updateAntigravityProviderSettings(settings, { enabled }),
  settingsReconciler: antigravitySettingsReconciler,
  settingsStorage: {
    hostScopedFields: ['cliPathsByHost', 'catalogsByHost', 'selectedModelsByHost'],
    normalizeStored(target, stored) {
      const storedConfig = getProviderConfig(stored, ANTIGRAVITY_PROVIDER_ID);
      const current = getAntigravityProviderSettings(stored);
      updateAntigravityProviderSettings(target, { ...current, visibleModels: getAntigravityMigratedVisibleModelIds(current) });
      return hasStoredConfigNormalization(storedConfig, getProviderConfig(target, ANTIGRAVITY_PROVIDER_ID));
    },
    projectPersistedConfig: projectAntigravityModelSettings,
  },
  taskResultInterpreter: NOOP_TASK_RESULT_INTERPRETER,
  workspace: antigravityWorkspaceRegistration,
};
