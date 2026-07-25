import type { ProviderModule } from '../../core/providers/types';
import { kimiWorkspaceRegistration } from './app/KimiWorkspaceServices';
import { KimiInlineEditService } from './auxiliary/KimiInlineEditService';
import { KimiInstructionRefineService } from './auxiliary/KimiInstructionRefineService';
import { KimiTaskResultInterpreter } from './auxiliary/KimiTaskResultInterpreter';
import { KimiTitleGenerationService } from './auxiliary/KimiTitleGenerationService';
import { KIMI_PROVIDER_CAPABILITIES } from './capabilities';
import { KIMI_ENVIRONMENT_KEY_PATTERNS, kimiSettingsReconciler } from './env/KimiSettingsReconciler';
import { KimiConversationHistoryService } from './history/KimiConversationHistoryService';
import { KimiChatRuntime } from './runtime/KimiChatRuntime';
import { getKimiProviderSettings, updateKimiProviderSettings } from './settings';
import { kimiChatUIConfig } from './ui/KimiChatUIConfig';

export const kimiProviderRegistration: ProviderModule = {
  id: 'kimi',
  blankTabOrder: 13,
  capabilities: KIMI_PROVIDER_CAPABILITIES,
  chatUIConfig: kimiChatUIConfig,
  createInlineEditService: (plugin) => new KimiInlineEditService(plugin),
  createInstructionRefineService: (plugin) => new KimiInstructionRefineService(plugin),
  createRuntime: ({ plugin }) => new KimiChatRuntime(plugin),
  createTitleGenerationService: (plugin) => new KimiTitleGenerationService(plugin),
  displayName: 'Kimi',
  environmentKeyPatterns: KIMI_ENVIRONMENT_KEY_PATTERNS,
  historyService: new KimiConversationHistoryService(),
  isEnabled: (settings) => getKimiProviderSettings(settings).enabled,
  setEnabled: (settings, enabled) => updateKimiProviderSettings(settings, { enabled }),
  settingsReconciler: kimiSettingsReconciler,
  settingsStorage: {
    hostScopedFields: ['cliPathsByHost'],
    normalizeStored(target, stored) {
      updateKimiProviderSettings(target, getKimiProviderSettings(stored));
      return false;
    },
  },
  taskResultInterpreter: new KimiTaskResultInterpreter(),
  workspace: kimiWorkspaceRegistration,
};
