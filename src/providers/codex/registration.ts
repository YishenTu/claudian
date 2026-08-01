import type { ProviderModule } from '../../core/providers/types';
import {
  codexWorkspaceRegistration,
} from './app/CodexWorkspaceServices';
import { CodexTaskResultInterpreter } from './auxiliary/CodexTaskResultInterpreter';
import { CODEX_PROVIDER_CAPABILITIES } from './capabilities';
import { codexSettingsReconciler } from './env/CodexSettingsReconciler';
import { CodexExecutionBackend } from './execution/CodexExecutionBackend';
import { CodexConversationHistoryService } from './history/CodexConversationHistoryService';
import { toCodexRuntimeModelId } from './modelSelection';
import { codexSubagentLifecycleAdapter } from './normalization/codexSubagentNormalization';
import {
  getCodexProviderSettings,
  normalizeCodexStoredConfig,
  updateCodexProviderSettings,
} from './settings';
import { codexChatUIConfig } from './ui/CodexChatUIConfig';

export const codexProviderRegistration: ProviderModule = {
  id: 'codex',
  displayName: 'Codex',
  blankTabOrder: 15,
  isEnabled: (settings) => getCodexProviderSettings(settings).enabled,
  setEnabled: (settings, enabled) => updateCodexProviderSettings(settings, { enabled }),
  capabilities: CODEX_PROVIDER_CAPABILITIES,
  environmentKeyPatterns: [/^OPENAI_/i, /^CODEX_/i],
  chatUIConfig: codexChatUIConfig,
  settingsReconciler: codexSettingsReconciler,
  settingsStorage: {
    hostScopedFields: ['cliPathsByHost', 'installationMethodsByHost', 'wslDistroOverridesByHost'],
    legacyTopLevelFields: [
      'codexSafeMode',
      'codexCliPath',
      'codexCliPathsByHost',
      'codexReasoningSummary',
      'codexEnabled',
      'lastCodexEnvHash',
    ],
    normalizeStored(target, stored) {
      const normalization = normalizeCodexStoredConfig(stored);
      target.providerConfigs ??= {};
      (target.providerConfigs as Record<string, unknown>).codex = normalization.config;
      return normalization.changed;
    },
  },
  createExecutionBackend: (plugin) => new CodexExecutionBackend(plugin),
  resolveTitleGenerationModel: (plugin) => {
    const settings = plugin.settings as unknown as Record<string, unknown>;
    const titleModel = typeof settings.titleGenerationModel === 'string'
      ? settings.titleGenerationModel
      : '';
    return codexChatUIConfig.ownsModel(titleModel, settings)
      ? toCodexRuntimeModelId(titleModel)
      : undefined;
  },
  historyService: new CodexConversationHistoryService(),
  taskResultInterpreter: new CodexTaskResultInterpreter(),
  subagentAdapter: codexSubagentLifecycleAdapter,
  workspace: codexWorkspaceRegistration,
};
