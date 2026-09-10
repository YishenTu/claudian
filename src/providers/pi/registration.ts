import { NOOP_TASK_RESULT_INTERPRETER } from '../../core/providers/NoopTaskResultInterpreter';
import { getProviderConfig } from '../../core/providers/providerConfig';
import { hasStoredConfigNormalization } from '../../core/providers/settings/storedSettings';
import type { ProviderModule } from '../../core/providers/types';
import { PiExecutionBackend } from '../pi-rpc/execution/PiExecutionBackend';
import { PiConversationHistoryService } from '../pi-rpc/history/PiConversationHistoryService';
import { ObsidianPiExtensionUiRenderer } from '../pi-rpc/ui/ObsidianPiExtensionUiRenderer';
import {
  getPiWorkspaceServices,
  piWorkspaceRegistration,
} from './app/PiWorkspaceServices';
import { PI_PROVIDER_CAPABILITIES } from './capabilities';
import { piSettingsReconciler } from './env/PiSettingsReconciler';
import { piFamilyProfile } from './profile';
import { getPiProviderSettings, updatePiProviderSettings } from './settings';
import { piChatUIConfig } from './ui/PiChatUIConfig';

export const piProviderRegistration: ProviderModule = {
  id: 'pi',
  blankTabOrder: 11,
  capabilities: PI_PROVIDER_CAPABILITIES,
  chatUIConfig: piChatUIConfig,
  createExecutionBackend: (plugin) => new PiExecutionBackend(
    piFamilyProfile,
    plugin,
    getPiWorkspaceServices(),
    {
      extensionUiRenderer: new ObsidianPiExtensionUiRenderer(plugin.app, {
        displayName: piFamilyProfile.displayName,
      }),
    },
  ),
  resolveTitleGenerationModel: (plugin) => {
    const settings = plugin.settings as unknown as Record<string, unknown>;
    const titleModel = typeof settings.titleGenerationModel === 'string'
      ? settings.titleGenerationModel
      : '';
    return piChatUIConfig.ownsModel(titleModel, settings) ? titleModel : undefined;
  },
  displayName: 'Pi',
  environmentKeyPatterns: [...piFamilyProfile.envKeyPatterns],
  historyService: new PiConversationHistoryService(piFamilyProfile),
  isEnabled: (settings) => getPiProviderSettings(settings).enabled,
  setEnabled: (settings, enabled) => updatePiProviderSettings(settings, { enabled }),
  settingsReconciler: piSettingsReconciler,
  settingsStorage: {
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
