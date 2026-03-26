import type { AppStorageService, ProviderRegistration } from '../../core/providers';
import { AgentManager } from './agents';
import { InlineEditService as ClaudeInlineEditService } from './aux/ClaudeInlineEditService';
import { InstructionRefineService as ClaudeInstructionRefineService } from './aux/ClaudeInstructionRefineService';
import { TitleGenerationService as ClaudeTitleGenerationService } from './aux/ClaudeTitleGenerationService';
import { CLAUDE_PROVIDER_CAPABILITIES } from './capabilities';
import { claudeSettingsReconciler } from './env/ClaudeSettingsReconciler';
import { ClaudeConversationHistoryService } from './history';
import { PluginManager } from './plugins';
import { ClaudeChatRuntime } from './runtime';
import { ClaudeCliResolver } from './runtime/ClaudeCliResolver';
import { ClaudeTaskResultInterpreter } from './runtime/ClaudeTaskResultInterpreter';
import { StorageService } from './storage';
import { DEFAULT_SETTINGS } from './types';
import { claudeChatUIConfig } from './ui/ClaudeChatUIConfig';

export const claudeProviderRegistration: ProviderRegistration = {
  capabilities: CLAUDE_PROVIDER_CAPABILITIES,
  chatUIConfig: claudeChatUIConfig,
  settingsReconciler: claudeSettingsReconciler,
  defaultSettings: DEFAULT_SETTINGS,
  createRuntime: ({ plugin, mcpManager }) => new ClaudeChatRuntime(plugin, mcpManager),
  createTitleGenerationService: (plugin) => new ClaudeTitleGenerationService(plugin),
  createInstructionRefineService: (plugin) => new ClaudeInstructionRefineService(plugin),
  createInlineEditService: (plugin) => new ClaudeInlineEditService(plugin),
  createCliResolver: () => new ClaudeCliResolver(),
  createStorageService: (plugin) => new StorageService(plugin) as unknown as AppStorageService,
  createPluginManager: (vaultPath, storage) =>
    new PluginManager(vaultPath, (storage as unknown as StorageService).ccSettings),
  createAgentManager: (vaultPath, pluginManager) =>
    new AgentManager(vaultPath, pluginManager as unknown as PluginManager),
  historyService: new ClaudeConversationHistoryService(),
  taskResultInterpreter: new ClaudeTaskResultInterpreter(),
};
