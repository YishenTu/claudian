import { getProviderConfig, setProviderConfig } from '../../core/providers/providerConfig';
import { hasStoredConfigNormalization } from '../../core/providers/settings/storedSettings';
import type { ProviderModule } from '../../core/providers/types';
import { claudeWorkspaceRegistration, getClaudeWorkspaceServices } from './app/ClaudeWorkspaceServices';
import { CLAUDE_PROVIDER_CAPABILITIES } from './capabilities';
import { claudeModelPolicy } from './ClaudeModelPolicy';
import { claudeSettingsReconciler } from './env/ClaudeSettingsReconciler';
import { ClaudeExecutionBackend } from './execution/ClaudeExecutionBackend';
import { ClaudeConversationHistoryService } from './history/ClaudeConversationHistoryService';
import { ClaudeSubagentHistoryService } from './history/ClaudeSubagentHistoryService';
import {
  getClaudeModelCatalog,
  getClaudeVisibleModelIds,
  hasClaudeModelIdentity,
  resolveClaudeVisibleModels,
} from './modelOptions';
import { projectClaudeModelSettings } from './modelPersistence';
import { ClaudeTaskResultInterpreter } from './runtime/ClaudeTaskResultInterpreter';
import { getClaudeProviderSettings, updateClaudeProviderSettings } from './settings';
import { claudeSubagentAdapter } from './subagentAdapter';
import { claudeChatUIConfig } from './ui/ClaudeChatUIConfig';

const RETIRED_CLAUDE_CONFIG_KEYS = ['defaultModel', 'effortMetadataMigrated'];

export const claudeProviderRegistration: ProviderModule = {
  id: 'claude',
  displayName: 'Claude Code',
  blankTabOrder: 20,
  isEnabled: settings => getClaudeProviderSettings(settings).enabled,
  setEnabled: (settings, enabled) => updateClaudeProviderSettings(settings, { enabled }),
  capabilities: CLAUDE_PROVIDER_CAPABILITIES,
  environmentKeyPatterns: [/^ANTHROPIC_/i, /^CLAUDE_/i],
  modelPolicy: claudeModelPolicy,
  chatUIConfig: claudeChatUIConfig,
  settingsReconciler: claudeSettingsReconciler,
  settingsStorage: {
    projectPersistedConfig: projectClaudeModelSettings,
    needsReasoningMetadata(settings) {
      const catalog = getClaudeModelCatalog(settings);
      return resolveClaudeVisibleModels(settings, catalog).some(({ id, option }) => !option
        || !hasClaudeModelIdentity(catalog, id)
        || (!option.supportedEffortLevels?.length && !option.reasoningMetadataResolved));
    },
    hostScopedFields: ['cliPathsByHost'],
    normalizeStored(target, stored) {
      const storedConfig = getProviderConfig(stored, 'claude');
      const storedSettings = getClaudeProviderSettings(stored);
      updateClaudeProviderSettings(target, {
        ...storedSettings,
        visibleModels: getClaudeVisibleModelIds(stored),
      });
      const targetConfig = getProviderConfig(target, 'claude');
      for (const key of RETIRED_CLAUDE_CONFIG_KEYS) delete targetConfig[key];
      setProviderConfig(target, 'claude', targetConfig);
      return RETIRED_CLAUDE_CONFIG_KEYS.some(key => key in storedConfig)
        || hasStoredConfigNormalization(storedConfig, targetConfig);
    },
  },
  createExecutionBackend: plugin => new ClaudeExecutionBackend(plugin, {
    publishSessionModels: models => getClaudeWorkspaceServices()?.publishSessionModels(models),
  }),
  createSubagentHistoryService: plugin => new ClaudeSubagentHistoryService(plugin),

  historyService: new ClaudeConversationHistoryService(),
  taskResultInterpreter: new ClaudeTaskResultInterpreter(),
  subagentAdapter: claudeSubagentAdapter,
  workspace: claudeWorkspaceRegistration,
};
