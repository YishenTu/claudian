import { NOOP_TASK_RESULT_INTERPRETER } from '../../core/providers/NoopTaskResultInterpreter';
import type { ProviderModule } from '../../core/providers/types';
import {
  codexWorkspaceRegistration,
} from './app/CodexWorkspaceServices';
import { CODEX_PROVIDER_CAPABILITIES } from './capabilities';
import { codexModelPolicy } from './CodexModelPolicy';
import { codexSettingsReconciler } from './env/CodexSettingsReconciler';
import { CodexExecutionBackend } from './execution/CodexExecutionBackend';
import { CodexConversationHistoryService } from './history/CodexConversationHistoryService';
import { findCodexModel } from './models';
import { codexSubagentLifecycleAdapter } from './normalization/codexSubagentNormalization';
import {
  getCodexProviderSettings, getVisibleCodexModelIds,
  normalizeCodexStoredConfig, projectCodexModelSettings, updateCodexProviderSettings
} from './settings';
import { codexChatUIConfig } from './ui/CodexChatUIConfig';

export const codexProviderRegistration: ProviderModule = {
  id: 'codex',
  displayName: 'Codex',
  blankTabOrder: 15,
  isEnabled: (settings) => getCodexProviderSettings(settings).enabled,
  setEnabled: (settings, enabled) => updateCodexProviderSettings(settings, { enabled }),
  capabilities: CODEX_PROVIDER_CAPABILITIES,
  environmentKeyPatterns: [/^OPENAI_/i, /^CODEX_/i],
  modelPolicy: codexModelPolicy,
  chatUIConfig: codexChatUIConfig,
  settingsReconciler: codexSettingsReconciler,
  settingsStorage: {
    projectPersistedConfig: projectCodexModelSettings,
    needsReasoningMetadata(settings) {
      const current = getCodexProviderSettings(settings);
      return getVisibleCodexModelIds(current.visibleModels, current.discoveredModels)
        .some(id => !findCodexModel(current.discoveredModels, id)?.supportedReasoningEfforts.length);
    },
    hostScopedFields: ['cliPathsByHost', 'installationMethodsByHost', 'wslDistroOverridesByHost'],
    normalizeStored(target, stored) {
      const normalization = normalizeCodexStoredConfig(stored);
      normalization.config.visibleModels = getVisibleCodexModelIds(normalization.config.visibleModels, normalization.config.discoveredModels);
      target.providerConfigs ??= {};
      (target.providerConfigs as Record<string, unknown>).codex = normalization.config;
      return normalization.changed;
    },
  },
  createExecutionBackend: (plugin) => new CodexExecutionBackend(plugin),

  historyService: new CodexConversationHistoryService(),
  taskResultInterpreter: NOOP_TASK_RESULT_INTERPRETER,
  subagentAdapter: codexSubagentLifecycleAdapter,
  workspace: codexWorkspaceRegistration,
};
