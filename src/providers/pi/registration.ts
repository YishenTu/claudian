import { NOOP_TASK_RESULT_INTERPRETER } from '../../core/providers/NoopTaskResultInterpreter';
import { getProviderConfig } from '../../core/providers/providerConfig';
import { hasStoredConfigNormalization } from '../../core/providers/settings/storedSettings';
import type { ProviderModule } from '../../core/providers/types';
import {
  getPiWorkspaceServices,
  piWorkspaceRegistration,
} from './app/PiWorkspaceServices';
import { PI_PROVIDER_CAPABILITIES } from './capabilities';
import { piSettingsReconciler } from './env/PiSettingsReconciler';
import { PiExecutionBackend } from './execution/PiExecutionBackend';
import { PiConversationHistoryService } from './history/PiConversationHistoryService';
import { getPiProviderSettings, projectPiModelSettings, updatePiProviderSettings } from './settings';
import { ObsidianPiExtensionUIRenderer } from './ui/ObsidianPiExtensionUIRenderer';
import { piChatUIConfig } from './ui/PiChatUIConfig';

export const piProviderRegistration: ProviderModule = {
  id: 'pi',
  blankTabOrder: 11,
  capabilities: PI_PROVIDER_CAPABILITIES,
  chatUIConfig: piChatUIConfig,
  createExecutionBackend: (plugin) => new PiExecutionBackend(
    plugin,
    getPiWorkspaceServices(),
    { extensionUiRenderer: new ObsidianPiExtensionUIRenderer(plugin.app) },
  ),

  displayName: 'Pi',
  environmentKeyPatterns: [/^PI_/i],
  historyService: new PiConversationHistoryService(),
  isEnabled: (settings) => getPiProviderSettings(settings).enabled,
  setEnabled: (settings, enabled) => updatePiProviderSettings(settings, { enabled }),
  settingsReconciler: piSettingsReconciler,
  settingsStorage: {
    projectPersistedConfig: projectPiModelSettings,
    needsReasoningMetadata(settings) {
      const current = getPiProviderSettings(settings);
      return current.visibleModels.some(id => {
        const model = current.discoveredModels.find(model => model.encodedId === id);
        return !model || model.reasoningMetadataResolved === false;
      });
    },
    hostScopedFields: ['cliPathsByHost'],
    normalizeStored(target, stored) {
      const storedConfig = getProviderConfig(stored, 'pi');
      updatePiProviderSettings(target, getPiProviderSettings(stored));
      return hasStoredConfigNormalization(
        storedConfig,
        getProviderConfig(target, 'pi'),
      );
    },
  },
  taskResultInterpreter: NOOP_TASK_RESULT_INTERPRETER,
  workspace: piWorkspaceRegistration,
};
