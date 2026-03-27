import type { ProviderRegistration } from '../../core/providers/types';
import { CodexInlineEditService } from './aux/CodexInlineEditService';
import { CodexInstructionRefineService } from './aux/CodexInstructionRefineService';
import { CodexTaskResultInterpreter } from './aux/CodexTaskResultInterpreter';
import { CodexTitleGenerationService } from './aux/CodexTitleGenerationService';
import { CODEX_PROVIDER_CAPABILITIES } from './capabilities';
import { codexSettingsReconciler } from './env/CodexSettingsReconciler';
import { CodexConversationHistoryService } from './history/CodexConversationHistoryService';
import { CodexChatRuntime } from './runtime/CodexChatRuntime';
import { codexChatUIConfig } from './ui/CodexChatUIConfig';

export const codexProviderRegistration: ProviderRegistration = {
  capabilities: CODEX_PROVIDER_CAPABILITIES,
  chatUIConfig: codexChatUIConfig,
  settingsReconciler: codexSettingsReconciler,
  createRuntime: ({ plugin }) => new CodexChatRuntime(plugin),
  createTitleGenerationService: () => new CodexTitleGenerationService(),
  createInstructionRefineService: () => new CodexInstructionRefineService(),
  createInlineEditService: () => new CodexInlineEditService(),
  historyService: new CodexConversationHistoryService(),
  taskResultInterpreter: new CodexTaskResultInterpreter(),
};
