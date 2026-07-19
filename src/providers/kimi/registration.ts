import type { ProviderModule } from '../../core/providers/types';
import { kimiWorkspaceRegistration } from './app/KimiWorkspaceServices';
import { KimiInlineEditService } from './auxiliary/KimiInlineEditService';
import { KimiInstructionRefineService } from './auxiliary/KimiInstructionRefineService';
import { KimiTaskResultInterpreter } from './auxiliary/KimiTaskResultInterpreter';
import { KimiTitleGenerationService } from './auxiliary/KimiTitleGenerationService';
import { KIMI_PROVIDER_CAPABILITIES } from './capabilities';
import { kimiSettingsReconciler } from './env/KimiSettingsReconciler';
import { KimiConversationHistoryService } from './history/KimiConversationHistoryService';
import { KimiChatRuntime } from './runtime/KimiChatRuntime';
import { getKimiProviderSettings, updateKimiProviderSettings } from './settings';
import { kimiChatUIConfig } from './ui/KimiChatUIConfig';

export const kimiProviderRegistration: ProviderModule = {
  id: 'kimi',
  displayName: 'Kimi Code',
  // After existing providers (opencode 10, pi 11, codex 15, claude 20).
  blankTabOrder: 12,
  isEnabled: (settings) => getKimiProviderSettings(settings).enabled,
  setEnabled: (settings, enabled) => updateKimiProviderSettings(settings, { enabled }),
  capabilities: KIMI_PROVIDER_CAPABILITIES,
  environmentKeyPatterns: [/^KIMI_/i, /^MOONSHOT_/i],
  chatUIConfig: kimiChatUIConfig,
  settingsReconciler: kimiSettingsReconciler,
  settingsStorage: {
    hostScopedFields: ['cliPathsByHost'],
    normalizeStored(target, stored) {
      updateKimiProviderSettings(target, getKimiProviderSettings(stored));
      return false;
    },
  },
  createRuntime: ({ plugin }) => new KimiChatRuntime(plugin),
  createTitleGenerationService: (plugin) => new KimiTitleGenerationService(plugin),
  createInstructionRefineService: (plugin) => new KimiInstructionRefineService(plugin),
  createInlineEditService: (plugin) => new KimiInlineEditService(plugin),
  historyService: new KimiConversationHistoryService(),
  taskResultInterpreter: new KimiTaskResultInterpreter(),
  workspace: kimiWorkspaceRegistration,
};
