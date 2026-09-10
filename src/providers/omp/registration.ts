import { NOOP_TASK_RESULT_INTERPRETER } from '../../core/providers/NoopTaskResultInterpreter';
import { getProviderConfig } from '../../core/providers/providerConfig';
import { hasStoredConfigNormalization } from '../../core/providers/settings/storedSettings';
import type { ProviderModule } from '../../core/providers/types';
import { PiExecutionBackend } from '../pi-rpc/execution/PiExecutionBackend';
import { PiConversationHistoryService } from '../pi-rpc/history/PiConversationHistoryService';
import { ObsidianPiExtensionUiRenderer } from '../pi-rpc/ui/ObsidianPiExtensionUiRenderer';
import { getOmpWorkspaceServices, ompWorkspaceRegistration } from './app/OmpWorkspaceServices';
import { OMP_PROVIDER_CAPABILITIES } from './capabilities';
import { ompSettingsReconciler } from './env/OmpSettingsReconciler';
import { ompFamilyProfile } from './profile';
import { getOmpProviderSettings, updateOmpProviderSettings } from './settings';
import { ompChatUIConfig } from './ui/OmpChatUIConfig';

export const ompProviderRegistration: ProviderModule = {
  id: 'omp',
  blankTabOrder: 13,
  capabilities: OMP_PROVIDER_CAPABILITIES,
  chatUIConfig: ompChatUIConfig,
  createExecutionBackend: (plugin) => new PiExecutionBackend(
    ompFamilyProfile,
    plugin,
    getOmpWorkspaceServices(),
    {
      extensionUiRenderer: new ObsidianPiExtensionUiRenderer(plugin.app, {
        displayName: ompFamilyProfile.displayName,
      }),
    },
  ),
  resolveTitleGenerationModel: (plugin) => {
    const settings = plugin.settings as unknown as Record<string, unknown>;
    const titleModel = typeof settings.titleGenerationModel === 'string'
      ? settings.titleGenerationModel
      : '';
    return ompChatUIConfig.ownsModel(titleModel, settings) ? titleModel : undefined;
  },
  displayName: 'Oh My Pi',
  environmentKeyPatterns: [...ompFamilyProfile.envKeyPatterns],
  historyService: new PiConversationHistoryService(ompFamilyProfile),
  isEnabled: (settings) => getOmpProviderSettings(settings).enabled,
  setEnabled: (settings, enabled) => updateOmpProviderSettings(settings, { enabled }),
  settingsReconciler: ompSettingsReconciler,
  settingsStorage: {
    hostScopedFields: ['cliPathsByHost'],
    normalizeStored(target, stored) {
      const storedConfig = getProviderConfig(stored, 'omp');
      updateOmpProviderSettings(target, getOmpProviderSettings(stored));
      return hasStoredConfigNormalization(
        storedConfig,
        getProviderConfig(target, 'omp'),
      );
    },
  },
  taskResultInterpreter: NOOP_TASK_RESULT_INTERPRETER,
  workspace: ompWorkspaceRegistration,
};
