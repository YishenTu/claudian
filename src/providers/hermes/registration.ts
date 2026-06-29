import type { ProviderRegistration } from '../../core/providers/types';
import { HermesInlineEditService } from './auxiliary/HermesInlineEditService';
import { HermesInstructionRefineService } from './auxiliary/HermesInstructionRefineService';
import { HermesTaskResultInterpreter } from './auxiliary/HermesTaskResultInterpreter';
import { HermesTitleGenerationService } from './auxiliary/HermesTitleGenerationService';
import { HERMES_PROVIDER_CAPABILITIES } from './capabilities';
import { hermesSettingsReconciler } from './env/HermesSettingsReconciler';
import { HermesConversationHistoryService } from './history/HermesConversationHistoryService';
import { HermesChatRuntime } from './runtime/HermesChatRuntime';
import { getHermesProviderSettings } from './settings';
import { hermesChatUIConfig } from './ui/HermesChatUIConfig';

export const hermesProviderRegistration: ProviderRegistration = {
  blankTabOrder: 12,
  capabilities: HERMES_PROVIDER_CAPABILITIES,
  chatUIConfig: hermesChatUIConfig,
  createInlineEditService: (plugin) => new HermesInlineEditService(plugin),
  createInstructionRefineService: (plugin) => new HermesInstructionRefineService(plugin),
  createRuntime: ({ plugin }) => new HermesChatRuntime(plugin),
  createTitleGenerationService: (plugin) => new HermesTitleGenerationService(plugin),
  displayName: 'Hermes',
  environmentKeyPatterns: [/^HERMES_/i],
  historyService: new HermesConversationHistoryService(),
  isEnabled: (settings) => getHermesProviderSettings(settings).enabled,
  settingsReconciler: hermesSettingsReconciler,
  taskResultInterpreter: new HermesTaskResultInterpreter(),
};
