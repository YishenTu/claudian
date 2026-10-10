import { NOOP_TASK_RESULT_INTERPRETER } from '@/core/providers/NoopTaskResultInterpreter';
import { getProviderConfig } from '@/core/providers/providerConfig';
import { hasStoredConfigNormalization } from '@/core/providers/settings/storedSettings';
import type { ProviderModule } from '@/core/providers/types';

import { deepseekWorkspaceRegistration, getDeepSeekWorkspaceServices } from './app/DeepSeekWorkspaceServices';
import { DEEPSEEK_PROVIDER_CAPABILITIES } from './capabilities';
import { deepseekModelPolicy } from './DeepSeekModelPolicy';
import { deepseekSettingsReconciler } from './env/DeepSeekSettingsReconciler';
import { DeepSeekExecutionBackend } from './execution/DeepSeekExecutionBackend';
import { DeepSeekConversationHistoryService } from './history/DeepSeekConversationHistoryService';
import { deepseekSubagentAdapter } from './normalization/DeepSeekSubagents';
import { getDeepSeekProviderSettings, projectDeepSeekModelSettings, updateDeepSeekProviderSettings } from './settings';
import { deepseekChatUIConfig } from './ui/DeepSeekChatUIConfig';

export const deepseekProviderRegistration: ProviderModule = {
  id: 'deepseek', displayName: 'DeepSeek Harness', blankTabOrder: 13,
  isEnabled: settings => getDeepSeekProviderSettings(settings).enabled,
  setEnabled: (settings, enabled) => { updateDeepSeekProviderSettings(settings, { enabled }); },
  modelPolicy: deepseekModelPolicy,
  chatUIConfig: deepseekChatUIConfig,
  capabilities: DEEPSEEK_PROVIDER_CAPABILITIES,
  environmentKeyPatterns: [/^DSH_/i, /^DEEPSEEK_/i],
  createExecutionBackend: host => new DeepSeekExecutionBackend(host, () => getDeepSeekWorkspaceServices().deepseek),
  historyService: new DeepSeekConversationHistoryService(async context => {
    await context?.ensureWorkspace?.();
    return getDeepSeekWorkspaceServices().deepseek;
  }),
  subagentAdapter: deepseekSubagentAdapter,
  taskResultInterpreter: NOOP_TASK_RESULT_INTERPRETER,
  workspace: deepseekWorkspaceRegistration,
  settingsStorage: {
    hostScopedFields: ['cliPathsByHost'], projectPersistedConfig: projectDeepSeekModelSettings,
    needsReasoningMetadata: settings => {
      const current = getDeepSeekProviderSettings(settings);
      return current.visibleModels.some(id => !current.discoveredModels.some(model => model.encodedId === id && Array.isArray(model.reasoning)));
    },
    normalizeStored(target, stored) {
      const previous = getProviderConfig(stored, 'deepseek');
      updateDeepSeekProviderSettings(target, getDeepSeekProviderSettings(stored));
      return hasStoredConfigNormalization(previous, getProviderConfig(target, 'deepseek'));
    },
  },
  settingsReconciler: deepseekSettingsReconciler,
};
