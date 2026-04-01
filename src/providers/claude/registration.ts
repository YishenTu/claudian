import type { ProviderRegistration } from '../../core/providers/types';
import { getClaudeWorkspaceServices } from './app/ClaudeWorkspaceServices';
import { InlineEditService as ClaudeInlineEditService } from './aux/ClaudeInlineEditService';
import { InstructionRefineService as ClaudeInstructionRefineService } from './aux/ClaudeInstructionRefineService';
import { TitleGenerationService as ClaudeTitleGenerationService } from './aux/ClaudeTitleGenerationService';
import { CLAUDE_PROVIDER_CAPABILITIES } from './capabilities';
import { claudeSettingsReconciler } from './env/ClaudeSettingsReconciler';
import { ClaudeConversationHistoryService } from './history/ClaudeConversationHistoryService';
import { ClaudianService as ClaudeChatRuntime } from './runtime/ClaudeChatRuntime';
import { ClaudeTaskResultInterpreter } from './runtime/ClaudeTaskResultInterpreter';
import { claudeChatUIConfig } from './ui/ClaudeChatUIConfig';

export const claudeProviderRegistration: ProviderRegistration = {
  displayName: 'Claude',
  blankTabOrder: 20,
  isEnabled: () => true,
  capabilities: CLAUDE_PROVIDER_CAPABILITIES,
  environmentKeyPatterns: [/^ANTHROPIC_/i, /^CLAUDE_/i],
  chatUIConfig: claudeChatUIConfig,
  settingsReconciler: claudeSettingsReconciler,
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
};
