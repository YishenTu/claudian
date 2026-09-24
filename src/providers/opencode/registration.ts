import { getProviderConfig } from '../../core/providers/providerConfig';
import { hasStoredConfigNormalization } from '../../core/providers/settings/storedSettings';
import type { ProviderModule } from '../../core/providers/types';
import {
  getOpencodeWorkspaceServices,
  opencodeWorkspaceRegistration,
} from './app/OpencodeWorkspaceServices';
import { OPENCODE_PROVIDER_CAPABILITIES } from './capabilities';
import { opencodeSettingsReconciler } from './env/OpencodeSettingsReconciler';
import { OpencodeExecutionBackend } from './execution/OpencodeExecutionBackend';
import { OpencodeConversationHistoryService } from './history/OpencodeConversationHistoryService';
import { opencodeTaskResultInterpreter } from './runtime/OpencodeTaskResultInterpreter';
import { getOpencodeProviderSettings, projectOpencodeModelSettings, updateOpencodeProviderSettings } from './settings';
import { opencodeSubagentAdapter } from './subagentAdapter';
import { opencodeChatUIConfig } from './ui/OpencodeChatUIConfig';

export const opencodeProviderRegistration: ProviderModule = {
  id: 'opencode',
  blankTabOrder: 10,
  capabilities: OPENCODE_PROVIDER_CAPABILITIES,
  chatUIConfig: opencodeChatUIConfig,
  createExecutionBackend: (plugin) => {
    const workspace = getOpencodeWorkspaceServices();
    return new OpencodeExecutionBackend(plugin, {
      commandCatalog: workspace.commandCatalog,
    });
  },

  displayName: 'OpenCode',
  environmentKeyPatterns: [/^OPENCODE_/i],
  historyService: new OpencodeConversationHistoryService(),
  isEnabled: (settings) => getOpencodeProviderSettings(settings).enabled,
  setEnabled: (settings, enabled) => updateOpencodeProviderSettings(settings, { enabled }),
  settingsReconciler: opencodeSettingsReconciler,
  settingsStorage: {
    projectPersistedConfig: projectOpencodeModelSettings,
    hostScopedFields: ['cliPathsByHost'],
    normalizeStored(target, stored) {
      const storedConfig = getProviderConfig(stored, 'opencode');
      const normalized = getOpencodeProviderSettings(stored);
      updateOpencodeProviderSettings(target, normalized);
      return hasStoredConfigNormalization(
        storedConfig,
        getProviderConfig(target, 'opencode'),
      );
    },
  },
  taskResultInterpreter: opencodeTaskResultInterpreter,
  subagentAdapter: opencodeSubagentAdapter,
  workspace: opencodeWorkspaceRegistration,
};
