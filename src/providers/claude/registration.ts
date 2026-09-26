import { getProviderConfig } from '../../core/providers/providerConfig';
import { hasStoredConfigNormalization } from '../../core/providers/settings/storedSettings';
import type { ProviderModule } from '../../core/providers/types';
import { claudeWorkspaceRegistration } from './app/ClaudeWorkspaceServices';
import { CLAUDE_PROVIDER_CAPABILITIES } from './capabilities';
import { claudeSettingsReconciler } from './env/ClaudeSettingsReconciler';
import { ClaudeExecutionBackend } from './execution/ClaudeExecutionBackend';
import { ClaudeConversationHistoryService } from './history/ClaudeConversationHistoryService';
import { ClaudeSubagentHistoryService } from './history/ClaudeSubagentHistoryService';
import { findClaudeModelOption, getClaudeVisibleModelIds } from './modelOptions';
import { projectClaudeModelSettings } from './modelPersistence';
import { ClaudeTaskResultInterpreter } from './runtime/ClaudeTaskResultInterpreter';
import { getClaudeProviderSettings, updateClaudeProviderSettings } from './settings';
import { claudeSubagentAdapter } from './subagentAdapter';
import { claudeChatUIConfig } from './ui/ClaudeChatUIConfig';

export const claudeProviderRegistration: ProviderModule = {
  id: 'claude',
  displayName: 'Claude',
  blankTabOrder: 20,
  isEnabled: settings => getClaudeProviderSettings(settings).enabled,
  setEnabled: (settings, enabled) => updateClaudeProviderSettings(settings, { enabled }),
  capabilities: CLAUDE_PROVIDER_CAPABILITIES,
  environmentKeyPatterns: [/^ANTHROPIC_/i, /^CLAUDE_/i],
  chatUIConfig: claudeChatUIConfig,
  settingsReconciler: claudeSettingsReconciler,
  settingsStorage: {
    projectPersistedConfig: projectClaudeModelSettings,
    needsReasoningMetadata(settings) {
      const models = getClaudeProviderSettings(settings).discoveredModels;
      return getClaudeVisibleModelIds(settings).some(id => {
        const model = findClaudeModelOption(models, id);
        return !model || (!model.supportedEffortLevels?.length && !model.reasoningMetadataResolved);
      });
    },
    hostScopedFields: ['cliPathsByHost'],
    normalizeStored(target, stored) {
      const storedConfig = getProviderConfig(stored, 'claude');
      const storedSettings = getClaudeProviderSettings(stored);
      updateClaudeProviderSettings(target, {
        ...storedSettings,
        visibleModels: getClaudeVisibleModelIds(stored),
      });
      return 'effortMetadataMigrated' in storedConfig || hasStoredConfigNormalization(
        storedConfig,
        getProviderConfig(target, 'claude'),
      );
    },
  },
  createExecutionBackend: plugin => new ClaudeExecutionBackend(plugin),
  createSubagentHistoryService: plugin => new ClaudeSubagentHistoryService(plugin),

  historyService: new ClaudeConversationHistoryService(),
  taskResultInterpreter: new ClaudeTaskResultInterpreter(),
  subagentAdapter: claudeSubagentAdapter,
  workspace: claudeWorkspaceRegistration,
};
