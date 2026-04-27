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
  displayName: 'Gemini',
  blankTabOrder: 20,
  isEnabled: (settings) => getGeminiProviderSettings(settings).enabled,
  capabilities: GEMINI_PROVIDER_CAPABILITIES,
  environmentKeyPatterns: [/^GEMINI_/i, /^GOOGLE_(API_KEY|GEMINI_)/i],
  chatUIConfig: geminiChatUIConfig,
  settingsReconciler: geminiSettingsReconciler,
  createRuntime: ({ plugin }) => new GeminiChatRuntime(plugin),
  createTitleGenerationService: (plugin) => new GeminiTitleGenerationService(plugin),
  createInstructionRefineService: (plugin) => new GeminiInstructionRefineService(plugin),
  createInlineEditService: (plugin) => new GeminiInlineEditService(plugin),
  historyService: new GeminiConversationHistoryService(),
  taskResultInterpreter: new GeminiTaskResultInterpreter(),
};
