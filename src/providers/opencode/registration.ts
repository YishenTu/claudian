import { NOOP_TASK_RESULT_INTERPRETER } from '../../core/providers/NoopTaskResultInterpreter';
import type { ProviderModule } from '../../core/providers/types';
import {
  getOpencodeWorkspaceServices,
  opencodeWorkspaceRegistration,
} from './app/OpencodeWorkspaceServices';
import { OPENCODE_PROVIDER_CAPABILITIES } from './capabilities';
import { opencodeSettingsReconciler } from './env/OpencodeSettingsReconciler';
import { OpencodeExecutionBackend } from './execution/OpencodeExecutionBackend';
import { OpencodeConversationHistoryService } from './history/OpencodeConversationHistoryService';
import { decodeOpencodeModelId } from './models';
import { getOpencodeProviderSettings, updateOpencodeProviderSettings } from './settings';
import { opencodeSubagentAdapter } from './subagentAdapter';
import { opencodeChatUIConfig } from './ui/OpencodeChatUIConfig';

export const opencodeProviderRegistration: ProviderModule = {
  id: 'opencode',
  blankTabOrder: 10,
  capabilities: OPENCODE_PROVIDER_CAPABILITIES,
  chatUIConfig: opencodeChatUIConfig,
  createExecutionBackend: (plugin) => {
    const workspace = getOpencodeWorkspaceServices();
    return new OpencodeExecutionBackend(plugin, {
      commandCatalog: workspace.commandCatalog,
    });
  },
  resolveTitleGenerationModel: (plugin) => {
    const settings = plugin.settings as unknown as Record<string, unknown>;
    const titleModel = typeof settings.titleGenerationModel === 'string'
      ? settings.titleGenerationModel
      : '';
    return opencodeChatUIConfig.ownsModel(titleModel, settings)
      ? decodeOpencodeModelId(titleModel) ?? undefined
      : undefined;
  },
  displayName: 'OpenCode',
  environmentKeyPatterns: [/^OPENCODE_/i],
  historyService: new OpencodeConversationHistoryService(),
  isEnabled: (settings) => getOpencodeProviderSettings(settings).enabled,
  setEnabled: (settings, enabled) => updateOpencodeProviderSettings(settings, { enabled }),
  settingsReconciler: opencodeSettingsReconciler,
  settingsStorage: {
    hostScopedFields: ['cliPathsByHost'],
    normalizeStored(target, stored) {
      updateOpencodeProviderSettings(target, getOpencodeProviderSettings(stored));
      return false;
    },
  },
  taskResultInterpreter: NOOP_TASK_RESULT_INTERPRETER,
  subagentAdapter: opencodeSubagentAdapter,
  workspace: opencodeWorkspaceRegistration,
};
