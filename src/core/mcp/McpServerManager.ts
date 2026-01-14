/**
 * McpServerManager - Core MCP server configuration management.
 *
 * Infrastructure layer for loading and filtering MCP server configurations.
 * No UI or @-mention logic - those belong in McpService and shared UI.
 */

import type { ClaudianMcpServer, McpServerConfig } from '../types';

/** Storage interface for loading MCP servers. */
export interface McpStorageAdapter {
  load(): Promise<ClaudianMcpServer[]>;
}

/** Manages MCP server configurations. */
export class McpServerManager {
  private servers: ClaudianMcpServer[] = [];
  private storage: McpStorageAdapter;

  constructor(storage: McpStorageAdapter) {
    this.storage = storage;
  }

  /** Load servers from storage. */
  async loadServers(): Promise<void> {
    this.servers = await this.storage.load();
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

  /**
   * Get disabled MCP tools formatted for SDK disallowedTools option.
   *
   * Only returns disabled tools from servers that would be active (same filter as getActiveServers).
   *
   * @param mentionedNames Set of server names that were @-mentioned in the prompt
   */
  getDisallowedMcpTools(mentionedNames: Set<string>): string[] {
    const disallowed = new Set<string>();

    for (const server of this.servers) {
      if (!server.enabled) continue;

      // If context-saving is enabled, only include if @-mentioned (same filter as getActiveServers)
      if (server.contextSaving && !mentionedNames.has(server.name)) {
        continue;
      }

      if (!server.disabledTools || server.disabledTools.length === 0) continue;

      for (const tool of server.disabledTools) {
        const normalized = tool.trim();
        if (!normalized) continue;
        disallowed.add(`mcp__${server.name}__${normalized}`);
      }
    }

    return Array.from(disallowed);
  }

  /**
   * Get all disabled MCP tools from ALL enabled servers (ignoring @-mentions).
   *
   * Used for persistent queries to pre-register all disabled tools upfront,
   * so @-mentioning servers doesn't require cold start.
   */
  getAllDisallowedMcpTools(): string[] {
    const disallowed = new Set<string>();

    for (const server of this.servers) {
      try {
        if (!server.enabled) continue;
        if (!server.disabledTools || server.disabledTools.length === 0) continue;

        for (const tool of server.disabledTools) {
          const normalized = tool.trim();
          if (!normalized) continue;
          disallowed.add(`mcp__${server.name}__${normalized}`);
        }
      } catch {
        // Skip malformed server configs
      }
    }

    return Array.from(disallowed).sort();
  }

  /** Check if any MCP servers are configured. */
  hasServers(): boolean {
    return this.servers.length > 0;
  }
}
