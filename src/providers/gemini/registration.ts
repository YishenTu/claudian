import type { ProviderRegistration } from '../../core/providers/types';
import { GeminiInlineEditService } from './auxiliary/GeminiInlineEditService';
import { GeminiInstructionRefineService } from './auxiliary/GeminiInstructionRefineService';
import { GeminiTaskResultInterpreter } from './auxiliary/GeminiTaskResultInterpreter';
import { GeminiTitleGenerationService } from './auxiliary/GeminiTitleGenerationService';
import { GEMINI_PROVIDER_CAPABILITIES } from './capabilities';
import { geminiSettingsReconciler } from './env/GeminiSettingsReconciler';
import { GeminiConversationHistoryService } from './history/GeminiConversationHistoryService';
import { GeminiChatRuntime } from './runtime/GeminiChatRuntime';
import { getGeminiProviderSettings } from './settings';
import { geminiChatUIConfig } from './ui/GeminiChatUIConfig';

export const geminiProviderRegistration: ProviderRegistration = {
  blankTabOrder: 12,
  capabilities: GEMINI_PROVIDER_CAPABILITIES,
  chatUIConfig: geminiChatUIConfig,
  createInlineEditService: (plugin) => new GeminiInlineEditService(plugin),
  createInstructionRefineService: (plugin) => new GeminiInstructionRefineService(plugin),
  createRuntime: ({ plugin }) => new GeminiChatRuntime(plugin),
  createTitleGenerationService: (plugin) => new GeminiTitleGenerationService(plugin),
  displayName: 'Gemini',
  environmentKeyPatterns: [/^GEMINI_/i, /^GOOGLE_/i, /^VERTEX_/i],
  historyService: new GeminiConversationHistoryService(),
  isEnabled: (settings) => getGeminiProviderSettings(settings).enabled,
  settingsReconciler: geminiSettingsReconciler,
  taskResultInterpreter: new GeminiTaskResultInterpreter(),
};
