import { getProviderConfig } from '../../core/providers/providerConfig';
import { hasStoredConfigNormalization } from '../../core/providers/settings/storedSettings';
import type { ProviderModule } from '../../core/providers/types';
import { claudeWorkspaceRegistration } from './app/ClaudeWorkspaceServices';
import { CLAUDE_PROVIDER_CAPABILITIES } from './capabilities';
import { migrateClaudeEffortMetadata } from './effortMetadataMigration';
import { claudeSettingsReconciler } from './env/ClaudeSettingsReconciler';
import { ClaudeExecutionBackend } from './execution/ClaudeExecutionBackend';
import { ClaudeConversationHistoryService } from './history/ClaudeConversationHistoryService';
import { ClaudeSubagentHistoryService } from './history/ClaudeSubagentHistoryService';
import { getClaudeVisibleModelIds } from './modelOptions';
import { projectClaudeModelSettings } from './modelPersistence';
import { ClaudeTaskResultInterpreter } from './runtime/ClaudeTaskResultInterpreter';
import { getClaudeProviderSettings, updateClaudeProviderSettings } from './settings';
import { claudeSubagentAdapter } from './subagentAdapter';
import { claudeChatUIConfig } from './ui/ClaudeChatUIConfig';

const LEGACY_CLAUDE_1M_SETTINGS = ['enableOpus1M', 'enableSonnet1M'] as const;

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
    hostScopedFields: ['cliPathsByHost'],
    legacyTopLevelFields: [
      'customModelAliases',
      'claudeSafeMode',
      'claudeCliPath',
      'claudeCliPathsByHost',
      'loadUserClaudeSettings',
      'lastClaudeModel',
      'enableChrome',
      'enableBangBash',
      ...LEGACY_CLAUDE_1M_SETTINGS,
      'environmentVariables',
      'lastEnvHash',
    ],
    normalizeStored(target, stored) {
      const storedConfig = getProviderConfig(stored, 'claude');
      const removedLegacy1MSettings = LEGACY_CLAUDE_1M_SETTINGS.some(key => key in storedConfig);
      const storedSettings = getClaudeProviderSettings(stored);
      const migrateEffortMetadata = !storedSettings.effortMetadataMigrated;
      updateClaudeProviderSettings(target, {
        ...storedSettings,
        visibleModels: getClaudeVisibleModelIds(stored),
        ...(migrateEffortMetadata ? {
          discoveredModels: migrateClaudeEffortMetadata(storedSettings.discoveredModels),
          effortMetadataMigrated: true,
        } : {}),
      });
      return removedLegacy1MSettings || migrateEffortMetadata || hasStoredConfigNormalization(
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
