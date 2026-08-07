import { getProviderConfig } from '../../core/providers/providerConfig';
import { hasStoredConfigNormalization } from '../../core/providers/settings/storedSettings';
import type { ProviderModule } from '../../core/providers/types';
import { parseEnvironmentVariables } from '../../utils/env';
import {
  claudeWorkspaceRegistration,
  getClaudeWorkspaceServices,
} from './app/ClaudeWorkspaceServices';
import { CLAUDE_PROVIDER_CAPABILITIES } from './capabilities';
import { claudeSettingsReconciler } from './env/ClaudeSettingsReconciler';
import { ClaudeExecutionBackend } from './execution/ClaudeExecutionBackend';
import { ClaudeConversationHistoryService } from './history/ClaudeConversationHistoryService';
import { ClaudeSubagentHistoryService } from './history/ClaudeSubagentHistoryService';
import { toClaudeRuntimeModelId } from './modelSelection';
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
    hostScopedFields: ['cliPathsByHost'],
    legacyTopLevelFields: [
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
      updateClaudeProviderSettings(target, getClaudeProviderSettings(stored));
      return removedLegacy1MSettings || hasStoredConfigNormalization(
        storedConfig,
        getProviderConfig(target, 'claude'),
      );
    },
  },
  createExecutionBackend: (plugin) => {
    const workspace = getClaudeWorkspaceServices();
    return new ClaudeExecutionBackend(plugin, workspace);
  },
  createSubagentHistoryService: plugin => new ClaudeSubagentHistoryService(plugin),
  resolveTitleGenerationModel: (plugin) => {
    const titleModel = plugin.settings.titleGenerationModel;
    if (titleModel && claudeChatUIConfig.ownsModel(titleModel, plugin.settings)) {
      return toClaudeRuntimeModelId(titleModel);
    }
    const envVars = parseEnvironmentVariables(
      plugin.getActiveEnvironmentVariables('claude'),
    );
    return envVars.ANTHROPIC_DEFAULT_HAIKU_MODEL || 'claude-haiku-4-5';
  },
  historyService: new ClaudeConversationHistoryService(),
  taskResultInterpreter: new ClaudeTaskResultInterpreter(),
  subagentAdapter: claudeSubagentAdapter,
  workspace: claudeWorkspaceRegistration,
};
