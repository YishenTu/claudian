/**
 * Claude-only workspace services.
 *
 * This module owns the Claude workspace boundary:
 * - Claude CLI resolution
 * - CC settings / permissions storage
 * - Slash command and skill catalogs
 * - Agent storage and manager
 * - Plugin manager
 * - MCP storage and manager
 */

import type { Plugin } from 'obsidian';

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
import type { SlashCommand } from '../../../core/types';
import type ClaudianPlugin from '../../../main';
import { AgentManager } from '../agents/AgentManager';
import { ClaudeCommandCatalog } from '../commands/ClaudeCommandCatalog';
import { PluginManager } from '../plugins/PluginManager';
import { ClaudeCliResolver } from '../runtime/ClaudeCliResolver';
import { StorageService } from '../storage/StorageService';
import { claudeSettingsTabRenderer } from '../ui/ClaudeSettingsTab';

/**
 * Full Claude storage surface.
 *
 * Extends the base StorageService and provides typed access to
 * Claude-owned storage sub-surfaces (commands, skills, agents, MCP,
 * CC settings, permissions).
 */
export type ClaudeStorageService = StorageService;

export interface ClaudeWorkspaceServices extends ProviderWorkspaceServices {
  claudeStorage: ClaudeStorageService;
  cliResolver: ProviderCliResolver;
  mcpStorage: AppMcpStorage;
  mcpManager: McpServerManager;
  pluginManager: AppPluginManager;
  agentStorage: AppAgentStorage;
  agentManager: AppAgentManager;
  commandCatalog: ProviderCommandCatalog;
  agentMentionProvider: AppAgentManager;
}

export function createClaudeStorage(
  plugin: Plugin,
  adapter?: VaultFileAdapter,
): ClaudeStorageService {
  return new StorageService(plugin, adapter);
}

export function createClaudeCliResolver(): ProviderCliResolver {
  return new ClaudeCliResolver();
}

export function createClaudePluginManager(
  vaultPath: string,
  claudeStorage: ClaudeStorageService,
): AppPluginManager {
  return new PluginManager(vaultPath, claudeStorage.ccSettings);
}

export function createClaudeAgentManager(
  vaultPath: string,
  pluginManager: AppPluginManager,
): AppAgentManager {
  return new AgentManager(vaultPath, pluginManager as unknown as PluginManager);
}

export function getClaudeMcpStorage(claudeStorage: ClaudeStorageService): AppMcpStorage {
  return claudeStorage.mcp;
}

export async function loadAllSlashCommands(claudeStorage: ClaudeStorageService): Promise<SlashCommand[]> {
  return claudeStorage.loadAllSlashCommands();
}

export async function createClaudeWorkspaceServices(
  plugin: ClaudianPlugin,
  adapter: VaultFileAdapter,
): Promise<ClaudeWorkspaceServices> {
  const claudeStorage = createClaudeStorage(plugin, adapter);
  await claudeStorage.ensureDirectories();
  const cliResolver = createClaudeCliResolver();
  const mcpStorage = getClaudeMcpStorage(claudeStorage);
  const mcpManager = new McpServerManager(mcpStorage);
  await mcpManager.loadServers();

  const vaultPath = (plugin.app.vault.adapter as { basePath?: string }).basePath ?? '';
  const pluginManager = createClaudePluginManager(vaultPath, claudeStorage);
  await pluginManager.loadPlugins();

  const agentStorage = claudeStorage.agents;
  const agentManager = createClaudeAgentManager(vaultPath, pluginManager);
  await agentManager.loadAgents();

  const commandCatalog = new ClaudeCommandCatalog(
    claudeStorage.commands,
    claudeStorage.skills,
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
