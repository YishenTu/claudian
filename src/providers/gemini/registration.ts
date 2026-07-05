import type { ProviderRegistration } from '../../core/providers/types';
import { GeminiInlineEditService } from './auxiliary/GeminiInlineEditService';
import { GeminiInstructionRefineService } from './auxiliary/GeminiInstructionRefineService';
import { GeminiTaskResultInterpreter } from './auxiliary/GeminiTaskResultInterpreter';
import { GeminiTitleGenerationService } from './auxiliary/GeminiTitleGenerationService';
import { geminiSettingsReconciler } from './env/GeminiSettingsReconciler';
import { GeminiConversationHistoryService } from './history/GeminiConversationHistoryService';
import { GeminiChatRuntime } from './runtime/GeminiChatRuntime';
import { getGeminiProviderSettings } from './settings';
import { geminiChatUIConfig } from './ui/GeminiChatUIConfig';
import { maybeGetGeminiWorkspaceServices } from './app/GeminiWorkspaceServices';

export const geminiProviderRegistration: ProviderRegistration = {
  blankTabOrder: 30,
  capabilities: {
    providerId: 'gemini',
    supportsPersistentRuntime: false,
    supportsNativeHistory: true,
    supportsPlanMode: false,
    supportsRewind: false,
    supportsFork: false,
    supportsProviderCommands: false,
    supportsImageAttachments: true,
    supportsInstructionMode: false,
    supportsMcpTools: true,
    reasoningControl: 'none',
  },
  chatUIConfig: geminiChatUIConfig,
  createInlineEditService: (plugin) => new GeminiInlineEditService(plugin),
  createInstructionRefineService: (plugin) => new GeminiInstructionRefineService(plugin),
  createRuntime: ({ plugin }) => {
    const services = maybeGetGeminiWorkspaceServices();
    if (!services?.mcpServerManager) {
      throw new Error('Gemini workspace services (MCP) are not initialized.');
    }
    return new GeminiChatRuntime(plugin, { mcpManager: services.mcpServerManager });
  },
  createTitleGenerationService: (plugin) => new GeminiTitleGenerationService(plugin),
  displayName: 'Gemini',
  environmentKeyPatterns: [/^GEMINI_/i],
  historyService: new GeminiConversationHistoryService(),
  isEnabled: (settings) => getGeminiProviderSettings(settings).enabled,
  settingsReconciler: geminiSettingsReconciler,
  taskResultInterpreter: new GeminiTaskResultInterpreter(),
};
