/**
 * Claude-only workspace services.
 *
 * These factories and types are explicitly Claude-owned. They are NOT part
 * of the generic provider registration contract and should not be required
 * by non-Claude providers.
 *
 * Covers:
 * - Claude CLI resolution
 * - CC settings / permissions storage
 * - Slash command and skill storage
 * - Agent storage and manager
 * - Plugin manager
 * - MCP storage
 */

import type { Plugin } from 'obsidian';

import type {
  AppAgentManager,
  AppMcpStorage,
  AppPluginManager,
  ProviderCliResolver,
} from '../../../core/providers/types';
import type { SlashCommand } from '../../../core/types';
import { AgentManager } from '../agents';
import { PluginManager } from '../plugins';
import { ClaudeCliResolver } from '../runtime/ClaudeCliResolver';
import { StorageService } from '../storage';

/**
 * Full Claude storage surface.
 *
 * Extends the base StorageService and provides typed access to
 * Claude-owned storage sub-surfaces (commands, skills, agents, MCP,
 * CC settings, permissions).
 */
export type ClaudeStorageService = StorageService;

export function createClaudeStorage(plugin: Plugin): ClaudeStorageService {
  return new StorageService(plugin);
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
