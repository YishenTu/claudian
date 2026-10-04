import { getProviderConfig } from '@/core/providers/providerConfig';
import { hasStoredConfigNormalization } from '@/core/providers/settings/storedSettings';
import type { ProviderModule } from '@/core/providers/types';

import { antigravityWorkspaceRegistration } from './app/AntigravityWorkspaceServices';
import {
  ANTIGRAVITY_PROVIDER_CAPABILITIES,
  getAntigravityConversationCapabilities,
} from './capabilities';
import { antigravitySettingsReconciler } from './env/AntigravitySettingsReconciler';
import { AntigravityExecutionBackend } from './execution/AntigravityExecutionBackend';
import { AntigravityConversationHistoryService } from './history/AntigravityConversationHistoryService';
import { antigravityModelPolicy } from './AntigravityModelPolicy';
import { antigravityTaskResultInterpreter } from './runtime/AntigravityTaskResultInterpreter';
import {
  getAntigravityProviderSettings,
  projectAntigravityModelSettings,
  updateAntigravityProviderSettings,
} from './settings';
import { antigravitySubagentAdapter } from './subagentAdapter';
import { antigravityChatUIConfig } from './ui/AntigravityChatUIConfig';

export const antigravityProviderRegistration: ProviderModule = {
  id: 'antigravity',
  blankTabOrder: 15,
  capabilities: ANTIGRAVITY_PROVIDER_CAPABILITIES,
  getConversationCapabilities: getAntigravityConversationCapabilities,
  modelPolicy: antigravityModelPolicy,
  chatUIConfig: antigravityChatUIConfig,
  createExecutionBackend: (plugin) => new AntigravityExecutionBackend(plugin),
  displayName: 'Google Antigravity',
  environmentKeyPatterns: [/^(GEMINI_|ANTIGRAVITY_)/i],
  historyService: new AntigravityConversationHistoryService(),
  isEnabled: (settings) => getAntigravityProviderSettings(settings).enabled,
  setEnabled: (settings, enabled) => updateAntigravityProviderSettings(settings, { enabled }),
  settingsReconciler: antigravitySettingsReconciler,
  settingsStorage: {
    projectPersistedConfig: projectAntigravityModelSettings,
    hostScopedFields: ['cliPathsByHost'],
    normalizeStored(target, stored) {
      const storedConfig = getProviderConfig(stored, 'antigravity');
      const normalized = getAntigravityProviderSettings(stored);
      updateAntigravityProviderSettings(target, normalized);
      return hasStoredConfigNormalization(
        storedConfig,
        getProviderConfig(target, 'antigravity'),
      );
    },
  },
  taskResultInterpreter: antigravityTaskResultInterpreter,
  subagentAdapter: antigravitySubagentAdapter,
  workspace: antigravityWorkspaceRegistration,
};
