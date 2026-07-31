import type { ProviderModule } from '../../core/providers/types';
import { opencodeWorkspaceRegistration } from './app/OpencodeWorkspaceServices';
import { OpencodeTaskResultInterpreter } from './auxiliary/OpencodeTaskResultInterpreter';
import { OpencodeTitleGenerationBackend } from './auxiliary/OpencodeTitleGenerationBackend';
import { OPENCODE_PROVIDER_CAPABILITIES } from './capabilities';
import { opencodeSettingsReconciler } from './env/OpencodeSettingsReconciler';
import { OpencodeConversationHistoryService } from './history/OpencodeConversationHistoryService';
import { OpencodeAuxQueryRunner } from './runtime/OpencodeAuxQueryRunner';
import { OpencodeChatRuntime } from './runtime/OpencodeChatRuntime';
import { getOpencodeProviderSettings, updateOpencodeProviderSettings } from './settings';
import { opencodeSubagentAdapter } from './subagentAdapter';
import { opencodeChatUIConfig } from './ui/OpencodeChatUIConfig';

export const opencodeProviderRegistration: ProviderModule = {
  id: 'opencode',
  blankTabOrder: 10,
  capabilities: OPENCODE_PROVIDER_CAPABILITIES,
  chatUIConfig: opencodeChatUIConfig,
  createInlineEditBackend: (plugin) => new OpencodeAuxQueryRunner(plugin, {
    agentProfile: 'readonly',
    artifactPurpose: 'inline',
    allowReadTextFile: true,
  }),
  createInstructionRefineBackend: (plugin) => new OpencodeAuxQueryRunner(plugin, {
    agentProfile: 'passive',
    artifactPurpose: 'instructions',
  }),
  createRuntime: ({ plugin }) => new OpencodeChatRuntime(plugin),
  createTitleGenerationBackend: (plugin) => new OpencodeTitleGenerationBackend(plugin),
  displayName: 'OpenCode',
  environmentKeyPatterns: [/^OPENCODE_/i],
  historyService: new OpencodeConversationHistoryService(),
  isEnabled: (settings) => getOpencodeProviderSettings(settings).enabled,
  setEnabled: (settings, enabled) => updateOpencodeProviderSettings(settings, { enabled }),
  settingsReconciler: opencodeSettingsReconciler,
  settingsStorage: {
    hostScopedFields: ['cliPathsByHost'],
    normalizeStored(target, stored) {
      updateOpencodeProviderSettings(target, getOpencodeProviderSettings(stored));
      return false;
    },
  },
  taskResultInterpreter: new OpencodeTaskResultInterpreter(),
  subagentAdapter: opencodeSubagentAdapter,
  workspace: opencodeWorkspaceRegistration,
};
