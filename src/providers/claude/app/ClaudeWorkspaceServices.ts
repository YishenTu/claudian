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
import {
  type ClaudeExecutionContext,
  resolveClaudeExecutionContext,
} from '../runtime/ClaudeExecutionContext';
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
  resolveExecutionContext(vaultPath?: string): ClaudeExecutionContext;
  refreshExecutionResources(): Promise<void>;
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
  let cachedExecutionContext: ClaudeExecutionContext | null = null;
  let cachedExecutionContextKey = '';
  const resolveExecutionContext = (requestedVaultPath = vaultPath): ClaudeExecutionContext => {
    const claudeSettings = plugin.settings.providerConfigs?.claude;
    const key = JSON.stringify([
      requestedVaultPath,
      claudeSettings,
      cliResolver.resolveFromSettings(plugin.settings),
    ]);
    if (cachedExecutionContext && key === cachedExecutionContextKey) {
      return cachedExecutionContext;
    }
    cachedExecutionContext = resolveClaudeExecutionContext({
      settings: plugin.settings,
      hostVaultPath: requestedVaultPath,
      resolvedCliPath: cliResolver.resolveFromSettings(plugin.settings),
    });
    cachedExecutionContextKey = key;
    return cachedExecutionContext;
  };
  let initialContext: ClaudeExecutionContext | null = null;
  try {
    initialContext = resolveExecutionContext();
  } catch {
    // Keep settings available so an invalid WSL selection can be corrected.
  }
  const pluginManager = new PluginManager(vaultPath, claudeStorage.ccSettings);
  if (initialContext?.claudeHomeHost) {
    pluginManager.configureGlobalPaths({
      globalClaudeDir: initialContext.claudeHomeHost,
      toHostPath: value => initialContext!.toHostPath(value),
    });
  }
  await pluginManager.loadPlugins();

  const agentStorage = claudeStorage.agents;
  const agentManager = new AgentManager(vaultPath, pluginManager, initialContext?.claudeHomeHost);
  await agentManager.loadAgents();

  const commandCatalog = new ClaudeCommandCatalog(
    claudeStorage.commands,
    claudeStorage.skills,
    () => probeRuntimeCommands(plugin),
  );
  const refreshExecutionResources = async (): Promise<void> => {
    const context = resolveExecutionContext();
    pluginManager.configureGlobalPaths({
      globalClaudeDir: context.claudeHomeHost,
      toHostPath: context.method === 'wsl' ? value => context.toHostPath(value) : undefined,
    });
    agentManager.setGlobalClaudeDir(context.claudeHomeHost);
    await pluginManager.loadPlugins();
    await agentManager.loadAgents();
    commandCatalog.invalidateCache();
  };

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
    resolveExecutionContext,
    refreshExecutionResources,
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
