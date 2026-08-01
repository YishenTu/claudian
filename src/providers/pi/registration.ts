import type { ProviderModule } from '../../core/providers/types';
import {
  getPiWorkspaceServices,
  piWorkspaceRegistration,
} from './app/PiWorkspaceServices';
import { PiTaskResultInterpreter } from './auxiliary/PiTaskResultInterpreter';
import { PI_PROVIDER_CAPABILITIES } from './capabilities';
import { piSettingsReconciler } from './env/PiSettingsReconciler';
import { PiExecutionBackend } from './execution/PiExecutionBackend';
import { PiConversationHistoryService } from './history/PiConversationHistoryService';
import { getPiProviderSettings, updatePiProviderSettings } from './settings';
import { ObsidianPiExtensionUiRenderer } from './ui/ObsidianPiExtensionUiRenderer';
import { piChatUIConfig } from './ui/PiChatUIConfig';

export const piProviderRegistration: ProviderModule = {
  id: 'pi',
  blankTabOrder: 11,
  capabilities: PI_PROVIDER_CAPABILITIES,
  chatUIConfig: piChatUIConfig,
  createExecutionBackend: (plugin) => new PiExecutionBackend(
    plugin,
    getPiWorkspaceServices(),
    { extensionUiRenderer: new ObsidianPiExtensionUiRenderer(plugin.app) },
  ),
  resolveTitleGenerationModel: (plugin) => {
    const settings = plugin.settings as unknown as Record<string, unknown>;
    const titleModel = typeof settings.titleGenerationModel === 'string'
      ? settings.titleGenerationModel
      : '';
    return piChatUIConfig.ownsModel(titleModel, settings) ? titleModel : undefined;
  },
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
