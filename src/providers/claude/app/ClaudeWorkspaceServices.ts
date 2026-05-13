import { McpServerManager } from '../../../core/mcp/McpServerManager';
import type { ProviderCommandCatalog } from '../../../core/providers/commands/ProviderCommandCatalog';
import { ProviderWorkspaceRegistry } from '../../../core/providers/ProviderWorkspaceRegistry';
import type {
  AppAgentManager,
  AppAgentStorage,
  AppMcpStorage,
  AppPluginManager,
  ProviderCliResolver,
  ProviderWorkspaceRegistration,
  ProviderWorkspaceServices,
} from '../../../core/providers/types';
import type { VaultFileAdapter } from '../../../core/storage/VaultFileAdapter';
import type ClaudianPlugin from '../../../main';
import { getVaultPath } from '../../../utils/path';
import { AgentManager } from '../agents/AgentManager';
import { ClaudeCommandCatalog } from '../commands/ClaudeCommandCatalog';
import { probeRuntimeCommands } from '../commands/probeRuntimeCommands';
import { PluginManager } from '../plugins/PluginManager';
import { ClaudeCliResolver } from '../runtime/ClaudeCliResolver';
import { StorageService } from '../storage/StorageService';
import { claudeSettingsTabRenderer } from '../ui/ClaudeSettingsTab';

export interface ClaudeWorkspaceServices extends ProviderWorkspaceServices {
  claudeStorage: StorageService;
  cliResolver: ProviderCliResolver;
  mcpStorage: AppMcpStorage;
  mcpManager: McpServerManager;
  pluginManager: AppPluginManager;
  agentStorage: AppAgentStorage;
  agentManager: AppAgentManager;
  commandCatalog: ProviderCommandCatalog;
  agentMentionProvider: AppAgentManager;
}

export async function createClaudeWorkspaceServices(
  plugin: ClaudianPlugin,
  adapter: VaultFileAdapter,
): Promise<ClaudeWorkspaceServices> {
  const claudeStorage = new StorageService(plugin, adapter);
  await claudeStorage.ensureDirectories();

  const cliResolver = new ClaudeCliResolver();
  const mcpStorage = claudeStorage.mcp;
  const mcpManager = new McpServerManager(mcpStorage);
  await mcpManager.loadServers();

  const vaultPath = getVaultPath(plugin.app) ?? '';
  const pluginManager = new PluginManager(vaultPath, claudeStorage.ccSettings);
  await pluginManager.loadPlugins();

  const agentStorage = claudeStorage.agents;
  const agentManager = new AgentManager(vaultPath, pluginManager);
  await agentManager.loadAgents();

  const commandCatalog = new ClaudeCommandCatalog(
    claudeStorage.commands,
    claudeStorage.skills,
    () => probeRuntimeCommands(plugin),
  );

  return {
    claudeStorage,
    cliResolver,
    mcpStorage,
    mcpServerManager: mcpManager,
    mcpManager,
    pluginManager,
    agentStorage,
    agentManager,
    commandCatalog,
    agentMentionProvider: agentManager,
    settingsTabRenderer: claudeSettingsTabRenderer,
    refreshAgentMentions: async () => {
      await agentManager.loadAgents();
    },
  };
}

export const claudeWorkspaceRegistration: ProviderWorkspaceRegistration<ClaudeWorkspaceServices> = {
  initialize: async ({ plugin, vaultAdapter }) => createClaudeWorkspaceServices(plugin, vaultAdapter),
};

export function maybeGetClaudeWorkspaceServices(): ClaudeWorkspaceServices | null {
  return ProviderWorkspaceRegistry.getServices('claude') as ClaudeWorkspaceServices | null;
}

export function getClaudeWorkspaceServices(): ClaudeWorkspaceServices {
  return ProviderWorkspaceRegistry.requireServices('claude') as ClaudeWorkspaceServices;
}
