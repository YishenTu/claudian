import type { ProviderModule } from '../../core/providers/types';
import {
  getGrokWorkspaceServices,
  grokWorkspaceRegistration,
  resolveGrokAuxiliaryLifecycle,
} from './app/GrokWorkspaceServices';
import { GrokTaskResultInterpreter } from './auxiliary/GrokTaskResultInterpreter';
import { GrokTitleGenerationBackend } from './auxiliary/GrokTitleGenerationBackend';
import { GROK_PROVIDER_CAPABILITIES } from './capabilities';
import { grokSettingsReconciler } from './env/GrokSettingsReconciler';
import { GrokConversationHistoryService } from './history/GrokConversationHistoryService';
import { grokSubagentLifecycleAdapter } from './normalization/grokSubagentNormalization';
import { GrokAuxQueryRunner } from './runtime/GrokAuxQueryRunner';
import { GrokChatRuntime } from './runtime/GrokChatRuntime';
import { getGrokProviderSettings, updateGrokProviderSettings } from './settings';
import { grokChatUIConfig } from './ui/GrokChatUIConfig';

export const grokProviderRegistration: ProviderModule = {
  id: 'grok',
  blankTabOrder: 12,
  capabilities: GROK_PROVIDER_CAPABILITIES,
  chatUIConfig: grokChatUIConfig,
  createInlineEditBackend: plugin => new GrokAuxQueryRunner(
    plugin,
    { resolveLifecycle: () => resolveGrokAuxiliaryLifecycle(plugin) },
  ),
  createInstructionRefineBackend: plugin => new GrokAuxQueryRunner(
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
  createTitleGenerationBackend: plugin => new GrokTitleGenerationBackend(
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
  subagentAdapter: grokSubagentLifecycleAdapter,
  taskResultInterpreter: new GrokTaskResultInterpreter(),
  workspace: grokWorkspaceRegistration,
};
