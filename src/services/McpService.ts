/**
 * McpService - Manages MCP server configurations and @-mention detection.
 *
 * Handles:
 * - Loading/reloading MCP server configurations from storage
 * - Filtering active servers based on enabled state and context-saving mode
 * - Extracting @-mentions from user prompts
 * - Providing server info for autocomplete
 */

import type ClaudianPlugin from '../main';
import type { ClaudianMcpServer, McpServerConfig } from '../types';
import { extractMcpMentions } from '../utils/mcp';

export class McpService {
  private plugin: ClaudianPlugin;
  private servers: ClaudianMcpServer[] = [];

  constructor(plugin: ClaudianPlugin) {
    this.plugin = plugin;
  }

  /** Load servers from storage. */
  async loadServers(): Promise<void> {
    this.servers = await this.plugin.storage.mcp.load();
  }

  /** Get all loaded servers. */
  getServers(): ClaudianMcpServer[] {
    return this.servers;
  }

  /** Get enabled servers count. */
  getEnabledCount(): number {
    return this.servers.filter((s) => s.enabled).length;
  }

  /**
   * Get servers to include in SDK options.
   *
   * A server is included if:
   * - It is enabled AND
   * - Either context-saving is disabled OR the server is @-mentioned
   *
   * @param mentionedNames Set of server names that were @-mentioned in the prompt
   */
  getActiveServers(mentionedNames: Set<string>): Record<string, McpServerConfig> {
    const result: Record<string, McpServerConfig> = {};

    for (const server of this.servers) {
      if (!server.enabled) continue;

      // If context-saving is enabled, only include if @-mentioned
      if (server.contextSaving && !mentionedNames.has(server.name)) {
        continue;
      }

      result[server.name] = server.config;
    }

    return result;
  }

  /** Get all server names for @-mention validation. */
  getServerNames(): string[] {
    return this.servers.map((s) => s.name);
  }

  /** Get enabled server names for @-mention validation. */
  getEnabledServerNames(): string[] {
    return this.servers.filter((s) => s.enabled).map((s) => s.name);
  }

  /** Get servers with context-saving enabled (for @-mention autocomplete). */
  getContextSavingServers(): ClaudianMcpServer[] {
    return this.servers.filter((s) => s.enabled && s.contextSaving);
  }

  /** Check if a server name is valid for @-mention. */
  isValidMcpMention(name: string): boolean {
    return this.servers.some((s) => s.name === name && s.enabled && s.contextSaving);
  }

  /**
   * Extract MCP mentions using this service's loaded servers.
   *
   * Only matches against enabled servers with context-saving mode.
   */
  extractMentions(text: string): Set<string> {
    const validNames = new Set(
      this.servers.filter((s) => s.enabled && s.contextSaving).map((s) => s.name)
    );
    return extractMcpMentions(text, validNames);
  }

  /**
   * Check if any MCP servers are configured.
   */
  hasServers(): boolean {
    return this.servers.length > 0;
  }

  /**
   * Check if any context-saving servers are enabled.
   */
  hasContextSavingServers(): boolean {
    return this.servers.some((s) => s.enabled && s.contextSaving);
  }
}
