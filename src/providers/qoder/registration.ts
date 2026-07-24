import type { ProviderModule } from '../../core/providers/types';
import { qoderWorkspaceRegistration } from './app/QoderWorkspaceServices';
import { QoderInlineEditService } from './auxiliary/QoderInlineEditService';
import { QoderInstructionRefineService } from './auxiliary/QoderInstructionRefineService';
import { QoderTaskResultInterpreter } from './auxiliary/QoderTaskResultInterpreter';
import { QoderTitleGenerationService } from './auxiliary/QoderTitleGenerationService';
import { QODER_PROVIDER_CAPABILITIES } from './capabilities';
import { qoderSettingsReconciler } from './env/QoderSettingsReconciler';
import { QoderConversationHistoryService } from './history/QoderConversationHistoryService';
import { QoderChatRuntime } from './runtime/QoderChatRuntime';
import { getQoderProviderSettings, updateQoderProviderSettings } from './settings';
import { qoderSubagentAdapter } from './subagentAdapter';
import { qoderChatUIConfig } from './ui/QoderChatUIConfig';

export const qoderProviderRegistration: ProviderModule = {
  id: 'qoder',
  blankTabOrder: 13,
  capabilities: QODER_PROVIDER_CAPABILITIES,
  chatUIConfig: qoderChatUIConfig,
  createInlineEditService: plugin => new QoderInlineEditService(plugin),
  createInstructionRefineService: plugin => new QoderInstructionRefineService(plugin),
  createRuntime: ({ plugin }) => new QoderChatRuntime(plugin),
  createTitleGenerationService: plugin => new QoderTitleGenerationService(plugin),
  displayName: 'Qoder',
  environmentKeyPatterns: [/^QODER_/i],
  historyService: new QoderConversationHistoryService(),
  isEnabled: settings => getQoderProviderSettings(settings).enabled,
  setEnabled: (settings, enabled) => updateQoderProviderSettings(settings, { enabled }),
  settingsReconciler: qoderSettingsReconciler,
  settingsStorage: {
    hostScopedFields: ['cliPathsByHost'],
    normalizeStored(target, stored) {
      updateQoderProviderSettings(target, getQoderProviderSettings(stored));
      return false;
    },
  },
  subagentAdapter: qoderSubagentAdapter,
  taskResultInterpreter: new QoderTaskResultInterpreter(),
  workspace: qoderWorkspaceRegistration,
};
