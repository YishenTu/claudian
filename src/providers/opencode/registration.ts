import type { ProviderRegistration } from '../../core/providers/types';
import { OpenCodeInlineEditService } from './aux/OpenCodeInlineEditService';
import { OpenCodeInstructionRefineService } from './aux/OpenCodeInstructionRefineService';
import { OpenCodeTitleGenerationService } from './aux/OpenCodeTitleGenerationService';
import { OPENCODE_PROVIDER_CAPABILITIES } from './capabilities';
import { OpenCodeConversationHistoryService } from './history/OpenCodeConversationHistoryService';
import { OpenCodeChatRuntime } from './runtime/OpenCodeChatRuntime';
import { openCodeChatUIConfig } from './ui/OpenCodeChatUIConfig';

export const openCodeProviderRegistration: ProviderRegistration = {
  displayName: 'OpenCode',
  blankTabOrder: 15, // Between Codex (10) and Claude (20)
  isEnabled: () => true,
  capabilities: OPENCODE_PROVIDER_CAPABILITIES,
  environmentKeyPatterns: [/^OPENCODE_/i, /^OPENAI_/i], // OpenCode uses OpenAI-compatible providers
  chatUIConfig: openCodeChatUIConfig,
  settingsReconciler: {
    reconcileModelWithEnvironment: () => ({ changed: false, invalidatedConversations: [] }),
    normalizeModelVariantSettings: () => false,
  },
  createRuntime: ({ plugin }) => {
    const runtime = new OpenCodeChatRuntime(plugin);
    return runtime;
  },
  createTitleGenerationService: (plugin) => new OpenCodeTitleGenerationService(plugin),
  createInstructionRefineService: (plugin) => new OpenCodeInstructionRefineService(plugin),
  createInlineEditService: (plugin) => new OpenCodeInlineEditService(plugin),
  historyService: new OpenCodeConversationHistoryService(),
  taskResultInterpreter: {
    hasAsyncLaunchMarker: () => false,
    extractAgentId: () => null,
    extractStructuredResult: () => null,
    resolveTerminalStatus: (_, fallback) => fallback,
    extractTagValue: () => null,
  },
};
