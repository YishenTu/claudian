import type { ProviderRegistration } from '../../core/providers';
import { InlineEditService as ClaudeInlineEditService } from './aux/ClaudeInlineEditService';
import { InstructionRefineService as ClaudeInstructionRefineService } from './aux/ClaudeInstructionRefineService';
import { TitleGenerationService as ClaudeTitleGenerationService } from './aux/ClaudeTitleGenerationService';
import { CLAUDE_PROVIDER_CAPABILITIES } from './capabilities';
import { claudeSettingsReconciler } from './env/ClaudeSettingsReconciler';
import { ClaudeConversationHistoryService } from './history';
import { ClaudeChatRuntime } from './runtime';
import { ClaudeTaskResultInterpreter } from './runtime/ClaudeTaskResultInterpreter';
import { claudeChatUIConfig } from './ui/ClaudeChatUIConfig';

export const claudeProviderRegistration: ProviderRegistration = {
  capabilities: CLAUDE_PROVIDER_CAPABILITIES,
  chatUIConfig: claudeChatUIConfig,
  settingsReconciler: claudeSettingsReconciler,
  createRuntime: ({ plugin, mcpManager }) => new ClaudeChatRuntime(plugin, mcpManager),
  createTitleGenerationService: (plugin) => new ClaudeTitleGenerationService(plugin),
  createInstructionRefineService: (plugin) => new ClaudeInstructionRefineService(plugin),
  createInlineEditService: (plugin) => new ClaudeInlineEditService(plugin),
  historyService: new ClaudeConversationHistoryService(),
  taskResultInterpreter: new ClaudeTaskResultInterpreter(),
};
