import type { ProviderRegistration } from '../../core/providers/types';
import { OctoAgentInlineEditService } from './auxiliary/OctoAgentInlineEditService';
import { OctoAgentInstructionRefineService } from './auxiliary/OctoAgentInstructionRefineService';
import { OctoAgentTaskResultInterpreter } from './auxiliary/OctoAgentTaskResultInterpreter';
import { OctoAgentTitleGenerationService } from './auxiliary/OctoAgentTitleGenerationService';
import { OCTO_AGENT_PROVIDER_CAPABILITIES } from './capabilities';
import { octoAgentSettingsReconciler } from './env/OctoAgentSettingsReconciler';
import { OctoAgentConversationHistoryService } from './history/OctoAgentConversationHistoryService';
import { OctoAgentChatRuntime } from './runtime/OctoAgentChatRuntime';
import { getOctoAgentProviderSettings } from './settings';
import { octoAgentChatUIConfig } from './ui/OctoAgentChatUIConfig';

export const octoAgentProviderRegistration: ProviderRegistration = {
  blankTabOrder: 15,
  capabilities: OCTO_AGENT_PROVIDER_CAPABILITIES,
  chatUIConfig: octoAgentChatUIConfig,
  createInlineEditService: (plugin) => new OctoAgentInlineEditService(plugin),
  createInstructionRefineService: (plugin) => new OctoAgentInstructionRefineService(plugin),
  createRuntime: ({ plugin }) => new OctoAgentChatRuntime(plugin),
  createTitleGenerationService: (plugin) => new OctoAgentTitleGenerationService(plugin),
  displayName: 'Octo Agent',
  environmentKeyPatterns: [/^OCTO_/i],
  historyService: new OctoAgentConversationHistoryService(),
  isEnabled: (settings) => {
    return getOctoAgentProviderSettings(settings).enabled;
  },
  settingsReconciler: octoAgentSettingsReconciler,
  taskResultInterpreter: new OctoAgentTaskResultInterpreter(),
};
