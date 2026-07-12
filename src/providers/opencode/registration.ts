import type { ProviderModule } from '../../core/providers/types';
import { opencodeWorkspaceRegistration } from './app/OpencodeWorkspaceServices';
import { OpencodeInlineEditService } from './auxiliary/OpencodeInlineEditService';
import { OpencodeInstructionRefineService } from './auxiliary/OpencodeInstructionRefineService';
import { OpencodeTaskResultInterpreter } from './auxiliary/OpencodeTaskResultInterpreter';
import { OpencodeTitleGenerationService } from './auxiliary/OpencodeTitleGenerationService';
import { OPENCODE_PROVIDER_CAPABILITIES } from './capabilities';
import { opencodeSettingsReconciler } from './env/OpencodeSettingsReconciler';
import { OpencodeConversationHistoryService } from './history/OpencodeConversationHistoryService';
import { OpencodeChatRuntime } from './runtime/OpencodeChatRuntime';
import { getOpencodeProviderSettings, updateOpencodeProviderSettings } from './settings';
import { opencodeChatUIConfig } from './ui/OpencodeChatUIConfig';

export const opencodeProviderRegistration: ProviderModule = {
  id: 'opencode',
  blankTabOrder: 10,
  capabilities: OPENCODE_PROVIDER_CAPABILITIES,
  chatUIConfig: opencodeChatUIConfig,
  createInlineEditService: (plugin) => new OpencodeInlineEditService(plugin),
  createInstructionRefineService: (plugin) => new OpencodeInstructionRefineService(plugin),
  createRuntime: ({ plugin }) => new OpencodeChatRuntime(plugin),
  createTitleGenerationService: (plugin) => new OpencodeTitleGenerationService(plugin),
  displayName: 'OpenCode',
  environmentKeyPatterns: [/^OPENCODE_/i],
  historyService: new OpencodeConversationHistoryService(),
  isEnabled: (settings) => getOpencodeProviderSettings(settings).enabled,
  settingsReconciler: opencodeSettingsReconciler,
  settingsStorage: {
    hostScopedFields: ['cliPathsByHost'],
    normalizeStored(target, stored) {
      updateOpencodeProviderSettings(target, getOpencodeProviderSettings(stored));
      return false;
    },
  },
  taskResultInterpreter: new OpencodeTaskResultInterpreter(),
  workspace: opencodeWorkspaceRegistration,
};
