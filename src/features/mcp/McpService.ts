/**
 * McpService - MCP feature service with @-mention detection.
 *
 * Wraps McpServerManager (core) and adds feature-specific logic:
 * - @-mention extraction and validation
 * - UI helper methods for autocomplete and dropdowns
 */

import { McpServerManager } from '../../core/mcp';
import type { ClaudianMcpServer, McpServerConfig } from '../../core/types';
import type ClaudianPlugin from '../../main';
import { extractMcpMentions, transformMcpMentions } from '../../utils/mcp';

export class McpService {
  private manager: McpServerManager;

  constructor(plugin: ClaudianPlugin) {
    this.manager = new McpServerManager(plugin.storage.mcp);
  }

  // ============================================
  // Delegated to McpServerManager (core)
  // ============================================

  /** Load servers from storage. */
  async loadServers(): Promise<void> {
    return this.manager.loadServers();
  }

  /** Get all loaded servers. */
  getServers(): ClaudianMcpServer[] {
    return this.manager.getServers();
  }

  /** Get enabled servers count. */
  getEnabledCount(): number {
    return this.manager.getEnabledCount();
  }

  /** Get servers to include in SDK options. */
  getActiveServers(mentionedNames: Set<string>): Record<string, McpServerConfig> {
    return this.manager.getActiveServers(mentionedNames);
  }

  /** Check if any MCP servers are configured. */
  hasServers(): boolean {
    return this.manager.hasServers();
  }

  // ============================================
  // Feature-specific: @-mention detection & UI
  // ============================================

  /** Get all server names for @-mention validation. */
  getServerNames(): string[] {
    return this.manager.getServers().map((s) => s.name);
  }

  /** Get enabled server names for @-mention validation. */
  getEnabledServerNames(): string[] {
    return this.manager.getServers().filter((s) => s.enabled).map((s) => s.name);
  }

  /** Get servers with context-saving enabled (for @-mention autocomplete). */
  getContextSavingServers(): ClaudianMcpServer[] {
    return this.manager.getServers().filter((s) => s.enabled && s.contextSaving);
  }

  /** Check if a server name is valid for @-mention. */
  isValidMcpMention(name: string): boolean {
    return this.manager.getServers().some((s) => s.name === name && s.enabled && s.contextSaving);
  }

  /**
   * Extract MCP mentions from text.
   * Only matches against enabled servers with context-saving mode.
   */
  extractMentions(text: string): Set<string> {
    const validNames = new Set(
      this.manager.getServers().filter((s) => s.enabled && s.contextSaving).map((s) => s.name)
    );
    return extractMcpMentions(text, validNames);
  }

  /** Check if any context-saving servers are enabled. */
  hasContextSavingServers(): boolean {
    return this.manager.getServers().some((s) => s.enabled && s.contextSaving);
  }

  /**
   * Transform MCP mentions in text by appending " MCP" after each valid @mention.
   * This is applied to API requests only, not shown in UI.
   */
  transformMentions(text: string): string {
    const validNames = new Set(
      this.manager.getServers().filter((s) => s.enabled && s.contextSaving).map((s) => s.name)
    );
    return transformMcpMentions(text, validNames);
  }

  // ============================================
  // Access to underlying manager (for core layer)
  // ============================================

  /** Get the underlying server manager. */
  getManager(): McpServerManager {
    return this.manager;
  }
}
