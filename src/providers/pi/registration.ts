import type { ProviderModule } from '../../core/providers/types';
import { piWorkspaceRegistration } from './app/PiWorkspaceServices';
import { PiInlineEditService } from './auxiliary/PiInlineEditService';
import { PiInstructionRefineService } from './auxiliary/PiInstructionRefineService';
import { PiTaskResultInterpreter } from './auxiliary/PiTaskResultInterpreter';
import { PiTitleGenerationService } from './auxiliary/PiTitleGenerationService';
import { PI_PROVIDER_CAPABILITIES } from './capabilities';
import { piSettingsReconciler } from './env/PiSettingsReconciler';
import { PiConversationHistoryService } from './history/PiConversationHistoryService';
import { PiChatRuntime } from './runtime/PiChatRuntime';
import { getPiProviderSettings, updatePiProviderSettings } from './settings';
import { ObsidianPiExtensionUiRenderer } from './ui/ObsidianPiExtensionUiRenderer';
import { piChatUIConfig } from './ui/PiChatUIConfig';

export const piProviderRegistration: ProviderModule = {
  id: 'pi',
  blankTabOrder: 11,
  capabilities: PI_PROVIDER_CAPABILITIES,
  chatUIConfig: piChatUIConfig,
  createInlineEditService: (plugin) => new PiInlineEditService(plugin),
  createInstructionRefineService: (plugin) => new PiInstructionRefineService(plugin),
  createRuntime: ({ plugin }) => new PiChatRuntime(plugin, {
    extensionUiRenderer: new ObsidianPiExtensionUiRenderer(plugin.app),
  }),
  createTitleGenerationService: (plugin) => new PiTitleGenerationService(plugin),
  displayName: 'Pi',
  environmentKeyPatterns: [/^PI_/i],
  historyService: new PiConversationHistoryService(),
  isEnabled: (settings) => getPiProviderSettings(settings).enabled,
  setEnabled: (settings, enabled) => updatePiProviderSettings(settings, { enabled }),
  settingsReconciler: piSettingsReconciler,
  settingsStorage: {
    hostScopedFields: ['cliPathsByHost'],
    normalizeStored(target, stored) {
      updatePiProviderSettings(target, getPiProviderSettings(stored));
      return false;
    },
  },
  taskResultInterpreter: new PiTaskResultInterpreter(),
  workspace: piWorkspaceRegistration,
};
