import { McpServerManager } from '../../../core/mcp/McpServerManager';
import type { ProviderCommandCatalog } from '../../../core/providers/commands/ProviderCommandCatalog';
import type { ProviderHost } from '../../../core/providers/ProviderHost';
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
import { parseEnvironmentVariables } from '../../../utils/env';
import { getVaultPath } from '../../../utils/path';
import { AgentManager } from '../agents/AgentManager';
import { ClaudeCommandCatalog } from '../commands/ClaudeCommandCatalog';
import { probeRuntimeCommands } from '../commands/probeRuntimeCommands';
import { resolveClaudeConfigDir } from '../config/ClaudeConfigDir';
import { PluginManager } from '../plugins/PluginManager';
import { ClaudeCliResolver } from '../runtime/ClaudeCliResolver';
import { StorageService } from '../storage/StorageService';
import { claudeSettingsTabRenderer } from '../ui/ClaudeSettingsTab';
import { ClaudeUsageGuardService } from '../usageGuard/ClaudeUsageGuardService';

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
  usageGuardService: ClaudeUsageGuardService;
}

export async function createClaudeWorkspaceServices(
  plugin: ProviderHost,
  adapter: VaultFileAdapter,
): Promise<ClaudeWorkspaceServices> {
  const claudeStorage = new StorageService(plugin, adapter);

  const cliResolver = new ClaudeCliResolver();
  const mcpStorage = claudeStorage.mcp;
  const mcpManager = new McpServerManager(mcpStorage);

  const vaultPath = getVaultPath(plugin.app) ?? '';
  const getClaudeConfigDir = () => resolveClaudeConfigDir({
    environment: {
      ...process.env,
      ...parseEnvironmentVariables(plugin.getActiveEnvironmentVariables('claude')),
    },
    hostPlatform: process.platform,
    vaultPath,
  });
  const pluginManager = new PluginManager(
    vaultPath,
    claudeStorage.ccSettings,
    getClaudeConfigDir,
  );

  const agentStorage = claudeStorage.agents;
  const agentManager = new AgentManager(vaultPath, pluginManager, getClaudeConfigDir);

  const commandCatalog = new ClaudeCommandCatalog(
    claudeStorage.commands,
    claudeStorage.skills,
    () => probeRuntimeCommands(plugin),
  );

  const usageGuardService = new ClaudeUsageGuardService(plugin);

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
    usageGuardService,
    refreshAgentMentions: async () => {
      await pluginManager.loadPlugins();
      await agentManager.loadAgents();
    },
    prepareSettings: async () => {
      await Promise.all([
        mcpManager.loadServers(),
        pluginManager.loadPlugins(),
      ]);
      await agentManager.loadAgents();
    },
    dispose: () => {
      usageGuardService.dispose();
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
