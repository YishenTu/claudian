import { NOOP_TASK_RESULT_INTERPRETER } from '../../core/providers/NoopTaskResultInterpreter';
import { getProviderConfig } from '../../core/providers/providerConfig';
import { hasStoredConfigNormalization } from '../../core/providers/settings/storedSettings';
import type { ProviderModule } from '../../core/providers/types';
import {
  getGrokWorkspaceServices,
  grokWorkspaceRegistration,
} from './app/GrokWorkspaceServices';
import { GROK_PROVIDER_CAPABILITIES } from './capabilities';
import { grokSettingsReconciler } from './env/GrokSettingsReconciler';
import { GrokExecutionBackend } from './execution/GrokExecutionBackend';
import { GrokConversationHistoryService } from './history/GrokConversationHistoryService';
import { isGrokModelSelectionId } from './models';
import { grokSubagentLifecycleAdapter } from './normalization/grokSubagentNormalization';
import { getGrokProviderSettings, updateGrokProviderSettings } from './settings';
import { grokChatUIConfig } from './ui/GrokChatUIConfig';

export const grokProviderRegistration: ProviderModule = {
  id: 'grok',
  blankTabOrder: 12,
  capabilities: GROK_PROVIDER_CAPABILITIES,
  chatUIConfig: grokChatUIConfig,
  createExecutionBackend: (plugin) => {
    const workspace = getGrokWorkspaceServices();
    return new GrokExecutionBackend(plugin, {
      commandCatalog: workspace.commandCatalog,
      modelCatalogCoordinator: workspace.modelCatalogCoordinator,
    });
  },
  resolveTitleGenerationModel: (plugin) => {
    const model = typeof plugin.settings.titleGenerationModel === 'string'
      ? plugin.settings.titleGenerationModel.trim()
      : '';
    return model && isGrokModelSelectionId(model) ? model : undefined;
  },
  displayName: 'Grok',
  environmentKeyPatterns: [/^GROK_/i, /^XAI_/i],
  historyService: new GrokConversationHistoryService(),
  isEnabled: settings => getGrokProviderSettings(settings).enabled,
  setEnabled: (settings, enabled) => updateGrokProviderSettings(settings, { enabled }),
  settingsReconciler: grokSettingsReconciler,
  settingsStorage: {
    hostScopedFields: ['cliPathsByHost', 'catalogsByHost'],
    normalizeStored(target, stored) {
      const storedConfig = getProviderConfig(stored, 'grok');
      updateGrokProviderSettings(target, getGrokProviderSettings(stored));
      return hasStoredConfigNormalization(
        storedConfig,
        getProviderConfig(target, 'grok'),
      );
    },
  },
  subagentAdapter: grokSubagentLifecycleAdapter,
  taskResultInterpreter: NOOP_TASK_RESULT_INTERPRETER,
  workspace: grokWorkspaceRegistration,
};
