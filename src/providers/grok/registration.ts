import type { ProviderModule } from '../../core/providers/types';
import {
  getGrokWorkspaceServices,
  grokWorkspaceRegistration,
  resolveGrokAuxiliaryLifecycle,
} from './app/GrokWorkspaceServices';
import { GrokInlineEditService } from './auxiliary/GrokInlineEditService';
import { GrokInstructionRefineService } from './auxiliary/GrokInstructionRefineService';
import { GrokTaskResultInterpreter } from './auxiliary/GrokTaskResultInterpreter';
import { GrokTitleGenerationService } from './auxiliary/GrokTitleGenerationService';
import { GROK_PROVIDER_CAPABILITIES } from './capabilities';
import { grokSettingsReconciler } from './env/GrokSettingsReconciler';
import { GrokConversationHistoryService } from './history/GrokConversationHistoryService';
import { grokSubagentLifecycleAdapter } from './normalization/grokSubagentNormalization';
import { GrokChatRuntime } from './runtime/GrokChatRuntime';
import { getGrokProviderSettings, updateGrokProviderSettings } from './settings';
import { grokChatUIConfig } from './ui/GrokChatUIConfig';

export const grokProviderRegistration: ProviderModule = {
  id: 'grok',
  blankTabOrder: 12,
  capabilities: GROK_PROVIDER_CAPABILITIES,
  chatUIConfig: grokChatUIConfig,
  createInlineEditService: plugin => new GrokInlineEditService(
    plugin,
    { resolveLifecycle: () => resolveGrokAuxiliaryLifecycle(plugin) },
  ),
  createInstructionRefineService: plugin => new GrokInstructionRefineService(
    plugin,
    { resolveLifecycle: () => resolveGrokAuxiliaryLifecycle(plugin) },
  ),
  createRuntime: ({ plugin }) => {
    const workspace = getGrokWorkspaceServices();
    return new GrokChatRuntime(plugin, {
      capabilities: GROK_PROVIDER_CAPABILITIES,
      cliResolver: workspace.cliResolver,
      lifecycle: workspace.auxiliaryLifecycle,
      modelCatalogCoordinator: workspace.modelCatalogCoordinator,
    });
  },
  createTitleGenerationService: plugin => new GrokTitleGenerationService(
    plugin,
    { resolveLifecycle: () => resolveGrokAuxiliaryLifecycle(plugin) },
  ),
  displayName: 'Grok',
  environmentKeyPatterns: [/^GROK_/i, /^XAI_/i],
  historyService: new GrokConversationHistoryService(),
  isEnabled: settings => getGrokProviderSettings(settings).enabled,
  setEnabled: (settings, enabled) => updateGrokProviderSettings(settings, { enabled }),
  settingsReconciler: grokSettingsReconciler,
  settingsStorage: {
    hostScopedFields: ['cliPathsByHost', 'catalogsByHost'],
    normalizeStored(target, stored) {
      updateGrokProviderSettings(target, getGrokProviderSettings(stored));
      return false;
    },
  },
  subagentLifecycleAdapter: grokSubagentLifecycleAdapter,
  taskResultInterpreter: new GrokTaskResultInterpreter(),
  workspace: grokWorkspaceRegistration,
};
