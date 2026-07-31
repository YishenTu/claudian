import type { ProviderModule } from '../../core/providers/types';
import { codexWorkspaceRegistration } from './app/CodexWorkspaceServices';
import { CodexTaskResultInterpreter } from './auxiliary/CodexTaskResultInterpreter';
import { CodexTitleGenerationBackend } from './auxiliary/CodexTitleGenerationBackend';
import { CODEX_PROVIDER_CAPABILITIES } from './capabilities';
import { codexSettingsReconciler } from './env/CodexSettingsReconciler';
import { CodexConversationHistoryService } from './history/CodexConversationHistoryService';
import { codexSubagentLifecycleAdapter } from './normalization/codexSubagentNormalization';
import { CodexAuxQueryRunner } from './runtime/CodexAuxQueryRunner';
import { CodexChatRuntime } from './runtime/CodexChatRuntime';
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
  createRuntime: ({ plugin }) => new CodexChatRuntime(plugin),
  createTitleGenerationBackend: (plugin) => new CodexTitleGenerationBackend(plugin),
  createInstructionRefineBackend: (plugin) => new CodexAuxQueryRunner(plugin),
  createInlineEditBackend: (plugin) => new CodexAuxQueryRunner(plugin),
  historyService: new CodexConversationHistoryService(),
  taskResultInterpreter: new CodexTaskResultInterpreter(),
  subagentAdapter: codexSubagentLifecycleAdapter,
  workspace: codexWorkspaceRegistration,
};
