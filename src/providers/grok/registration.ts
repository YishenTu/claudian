import type { ProviderModule } from '../../core/providers/types';
import { grokWorkspaceRegistration } from './app/GrokWorkspaceServices';
import { GrokInlineEditService } from './auxiliary/GrokInlineEditService';
import { GrokInstructionRefineService } from './auxiliary/GrokInstructionRefineService';
import { GrokTaskResultInterpreter } from './auxiliary/GrokTaskResultInterpreter';
import { GrokTitleGenerationService } from './auxiliary/GrokTitleGenerationService';
import { GROK_PROVIDER_CAPABILITIES } from './capabilities';
import { grokSettingsReconciler } from './env/GrokSettingsReconciler';
import { GrokConversationHistoryService } from './history/GrokConversationHistoryService';
import { GrokChatRuntime } from './runtime/GrokChatRuntime';
import { getGrokProviderSettings, updateGrokProviderSettings } from './settings';
import { grokChatUIConfig } from './ui/GrokChatUIConfig';

export const grokProviderRegistration: ProviderModule = {
  id: 'grok',
  displayName: 'Grok',
  blankTabOrder: 12,
  isEnabled: (settings) => getGrokProviderSettings(settings).enabled,
  setEnabled: (settings, enabled) => updateGrokProviderSettings(settings, { enabled }),
  capabilities: GROK_PROVIDER_CAPABILITIES,
  environmentKeyPatterns: [/^GROK_/i, /^XAI_/i],
  chatUIConfig: grokChatUIConfig,
  settingsReconciler: grokSettingsReconciler,
  settingsStorage: {
    hostScopedFields: ['cliPathsByHost'],
    normalizeStored(target, stored) {
      updateGrokProviderSettings(target, getGrokProviderSettings(stored));
      return false;
    },
  },
  createRuntime: ({ plugin }) => new GrokChatRuntime(plugin),
  createTitleGenerationService: (plugin) => new GrokTitleGenerationService(plugin),
  createInstructionRefineService: (plugin) => new GrokInstructionRefineService(plugin),
  createInlineEditService: (plugin) => new GrokInlineEditService(plugin),
  historyService: new GrokConversationHistoryService(),
  taskResultInterpreter: new GrokTaskResultInterpreter(),
  workspace: grokWorkspaceRegistration,
};
