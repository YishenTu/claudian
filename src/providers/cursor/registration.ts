import type { ProviderRegistration } from '../../core/providers/types';
import { CursorInlineEditService } from './auxiliary/CursorInlineEditService';
import { CursorInstructionRefineService } from './auxiliary/CursorInstructionRefineService';
import { CursorTaskResultInterpreter } from './auxiliary/CursorTaskResultInterpreter';
import { CursorTitleGenerationService } from './auxiliary/CursorTitleGenerationService';
import { CURSOR_PROVIDER_CAPABILITIES } from './capabilities';
import { cursorSettingsReconciler } from './env/CursorSettingsReconciler';
import { CursorConversationHistoryService } from './history/CursorConversationHistoryService';
import { CursorChatRuntime } from './runtime/CursorChatRuntime';
import { getCursorProviderSettings } from './settings';
import { cursorChatUIConfig } from './ui/CursorChatUIConfig';

export const cursorProviderRegistration: ProviderRegistration = {
  displayName: 'Cursor Agent',
  blankTabOrder: 8,
  isEnabled: (settings) => getCursorProviderSettings(settings).enabled,
  capabilities: CURSOR_PROVIDER_CAPABILITIES,
  environmentKeyPatterns: [/^CURSOR_/i],
  chatUIConfig: cursorChatUIConfig,
  settingsReconciler: cursorSettingsReconciler,
  createRuntime: ({ plugin }) => new CursorChatRuntime(plugin),
  createTitleGenerationService: (plugin) => new CursorTitleGenerationService(plugin),
  createInstructionRefineService: (plugin) => new CursorInstructionRefineService(plugin),
  createInlineEditService: (plugin) => new CursorInlineEditService(plugin),
  historyService: new CursorConversationHistoryService(),
  taskResultInterpreter: new CursorTaskResultInterpreter(),
};
