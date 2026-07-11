import type { ProviderModule } from '../../core/providers/types';
import {
  claudeWorkspaceRegistration,
  getClaudeWorkspaceServices,
} from './app/ClaudeWorkspaceServices';
import { InlineEditService as ClaudeInlineEditService } from './auxiliary/ClaudeInlineEditService';
import { InstructionRefineService as ClaudeInstructionRefineService } from './auxiliary/ClaudeInstructionRefineService';
import { TitleGenerationService as ClaudeTitleGenerationService } from './auxiliary/ClaudeTitleGenerationService';
import { CLAUDE_PROVIDER_CAPABILITIES } from './capabilities';
import { claudeSettingsReconciler } from './env/ClaudeSettingsReconciler';
import { ClaudeConversationHistoryService } from './history/ClaudeConversationHistoryService';
import { ClaudianService as ClaudeChatRuntime } from './runtime/ClaudeChatRuntime';
import { ClaudeTaskResultInterpreter } from './runtime/ClaudeTaskResultInterpreter';
import { getClaudeProviderSettings, updateClaudeProviderSettings } from './settings';
import { claudeChatUIConfig } from './ui/ClaudeChatUIConfig';

export const claudeProviderRegistration: ProviderModule = {
  id: 'claude',
  displayName: 'Claude',
  blankTabOrder: 20,
  isEnabled: () => true,
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
      'enableOpus1M',
      'enableSonnet1M',
      'environmentVariables',
      'lastEnvHash',
    ],
    normalizeStored(target, stored) {
      updateClaudeProviderSettings(target, getClaudeProviderSettings(stored));
      return false;
    },
  },
  createRuntime: ({ plugin }) => {
    const workspace = getClaudeWorkspaceServices();
    const resolvedMcpManager = workspace?.mcpManager;
    if (!resolvedMcpManager) {
      throw new Error('Claude workspace services are not initialized.');
    }

    return new ClaudeChatRuntime(plugin, {
      mcpManager: resolvedMcpManager,
      pluginManager: workspace?.pluginManager,
      agentManager: workspace?.agentManager,
    });
  },
  createTitleGenerationService: (plugin) => new ClaudeTitleGenerationService(plugin),
  createInstructionRefineService: (plugin) => new ClaudeInstructionRefineService(plugin),
  createInlineEditService: (plugin) => new ClaudeInlineEditService(plugin),
  historyService: new ClaudeConversationHistoryService(),
  taskResultInterpreter: new ClaudeTaskResultInterpreter(),
  workspace: claudeWorkspaceRegistration,
};
