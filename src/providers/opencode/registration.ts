import type { ProviderRegistration } from '../../core/providers/types';
import { OpencodeInlineEditService } from './auxiliary/OpencodeInlineEditService';
import { OpencodeInstructionRefineService } from './auxiliary/OpencodeInstructionRefineService';
import { OpencodeTaskResultInterpreter } from './auxiliary/OpencodeTaskResultInterpreter';
import { OpencodeTitleGenerationService } from './auxiliary/OpencodeTitleGenerationService';
import { OPENCODE_PROVIDER_CAPABILITIES } from './capabilities';
import { opencodeSettingsReconciler } from './env/OpencodeSettingsReconciler';
import { OpencodeConversationHistoryService } from './history/OpencodeConversationHistoryService';
import { OpencodeChatRuntime } from './runtime/OpencodeChatRuntime';
import { getOpencodeProviderSettings } from './settings';
import { opencodeChatUIConfig } from './ui/OpencodeChatUIConfig';

export const opencodeProviderRegistration: ProviderRegistration = {
  displayName: 'OpenCode',
  blankTabOrder: 20,
  isEnabled: (settings) => getOpencodeProviderSettings(settings).enabled,
  capabilities: OPENCODE_PROVIDER_CAPABILITIES,
  environmentKeyPatterns: [/^OPENCODE_/i, /^ANTHROPIC_/i, /^OPENAI_/i],
  chatUIConfig: opencodeChatUIConfig,
  settingsReconciler: opencodeSettingsReconciler,
  createRuntime: ({ plugin }) => new OpencodeChatRuntime(plugin),
  createTitleGenerationService: (plugin) => new OpencodeTitleGenerationService(plugin),
  createInstructionRefineService: (plugin) => new OpencodeInstructionRefineService(plugin),
  createInlineEditService: (plugin) => new OpencodeInlineEditService(plugin),
  historyService: new OpencodeConversationHistoryService(),
  taskResultInterpreter: new OpencodeTaskResultInterpreter(),
};
