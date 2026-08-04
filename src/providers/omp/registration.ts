import { NOOP_TASK_RESULT_INTERPRETER } from '../../core/providers/NoopTaskResultInterpreter';
import type { ProviderModule } from '../../core/providers/types';
import { ompWorkspaceRegistration } from './app/OmpWorkspaceServices';
import { OMP_PROVIDER_CAPABILITIES } from './capabilities';
import { ompSettingsReconciler } from './env/OmpSettingsReconciler';
import { OmpExecutionBackend } from './execution/OmpExecutionBackend';
import { OmpConversationHistoryService } from './history/OmpConversationHistoryService';
import { getOmpProviderSettings, updateOmpProviderSettings } from './settings';
import { ompChatUIConfig } from './ui/OmpChatUIConfig';

export const ompProviderRegistration: ProviderModule = {
  id: 'omp',
  blankTabOrder: 12,
  capabilities: OMP_PROVIDER_CAPABILITIES,
  chatUIConfig: ompChatUIConfig,
  createExecutionBackend: plugin => new OmpExecutionBackend(plugin),
  displayName: 'OMP',
  environmentKeyPatterns: [/^(?:OMP|PI)_/i],
  historyService: new OmpConversationHistoryService(),
  isEnabled: settings => getOmpProviderSettings(settings).enabled,
  setEnabled: (settings, enabled) => updateOmpProviderSettings(settings, { enabled }),
  settingsReconciler: ompSettingsReconciler,
  settingsStorage: {
    hostScopedFields: ['cliPathsByHost'],
    normalizeStored(target, stored) {
      updateOmpProviderSettings(target, getOmpProviderSettings(stored));
      return false;
    },
  },
  taskResultInterpreter: NOOP_TASK_RESULT_INTERPRETER,
  workspace: ompWorkspaceRegistration,
};
