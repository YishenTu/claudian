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
  blankTabOrder: 10,
  capabilities: OPENCODE_PROVIDER_CAPABILITIES,
  chatUIConfig: opencodeChatUIConfig,
  createInlineEditService: () => new OpencodeInlineEditService(),
  createInstructionRefineService: () => new OpencodeInstructionRefineService(),
  createRuntime: ({ plugin }) => new OpencodeChatRuntime(plugin),
  createTitleGenerationService: () => new OpencodeTitleGenerationService(),
  displayName: 'OpenCode',
  environmentKeyPatterns: [/^OPENCODE_/i],
  historyService: new OpencodeConversationHistoryService(),
  isEnabled: (settings) => getOpencodeProviderSettings(settings).enabled,
  settingsReconciler: opencodeSettingsReconciler,
  taskResultInterpreter: new OpencodeTaskResultInterpreter(),
};
