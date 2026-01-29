/**
 * McpServerManager - Core MCP server configuration management.
 *
 * Infrastructure layer for loading, filtering, and querying MCP server configurations.
 */

import { extractMcpMentions, transformMcpMentions } from '../../utils/mcp';
import type { ClaudianMcpServer, McpServerConfig } from '../types';

/** Storage interface for loading MCP servers. */
export interface McpStorageAdapter {
  load(): Promise<ClaudianMcpServer[]>;
}

export class McpServerManager {
  private servers: ClaudianMcpServer[] = [];
  private storage: McpStorageAdapter;

  constructor(storage: McpStorageAdapter) {
    this.storage = storage;
  }

  async loadServers(): Promise<void> {
    this.servers = await this.storage.load();
  }

  getServers(): ClaudianMcpServer[] {
    return this.servers;
  }

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
    return this.collectDisallowedTools(
      (s) => !s.contextSaving || mentionedNames.has(s.name)
    );
  }

  /**
   * Get all disabled MCP tools from ALL enabled servers (ignoring @-mentions).
   *
   * Used for persistent queries to pre-register all disabled tools upfront,
   * so @-mentioning servers doesn't require cold start.
   */
  getAllDisallowedMcpTools(): string[] {
    return this.collectDisallowedTools().sort();
  }

  private collectDisallowedTools(filter?: (server: ClaudianMcpServer) => boolean): string[] {
    const disallowed = new Set<string>();

    for (const server of this.servers) {
      if (!server.enabled) continue;
      if (filter && !filter(server)) continue;
      if (!server.disabledTools || server.disabledTools.length === 0) continue;

      for (const tool of server.disabledTools) {
        const normalized = tool.trim();
        if (!normalized) continue;
        disallowed.add(`mcp__${server.name}__${normalized}`);
      }
    }

    return Array.from(disallowed);
  }

  hasServers(): boolean {
    return this.servers.length > 0;
  }

  getContextSavingServers(): ClaudianMcpServer[] {
    return this.servers.filter((s) => s.enabled && s.contextSaving);
  }

  private getContextSavingNames(): Set<string> {
    return new Set(this.getContextSavingServers().map((s) => s.name));
  }

  /** Only matches against enabled servers with context-saving mode. */
  extractMentions(text: string): Set<string> {
    return extractMcpMentions(text, this.getContextSavingNames());
  }

  /**
   * Appends " MCP" after each valid @mention. Applied to API requests only, not shown in UI.
   */
  transformMentions(text: string): string {
    return transformMcpMentions(text, this.getContextSavingNames());
  }
}
