/**
 * McpStorage - Handles .claude/mcp.json read/write
 *
 * MCP server configurations are stored in Claude Code-compatible format
 * with optional Claudian-specific metadata in _claudian field.
 * Also loads read-only servers from the user-level ~/.claude/settings.json
 * (vault servers take precedence on name collision).
 *
 * File format:
 * {
 *   "mcpServers": {
 *     "server-name": { "command": "...", "args": [...] }
 *   },
 *   "_claudian": {
 *     "servers": {
 *       "server-name": { "enabled": true, "contextSaving": true, "disabledTools": ["tool"], "description": "..." }
 *     }
 *   }
 * }
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import type {
  ClaudianMcpConfigFile,
  ClaudianMcpServer,
  McpServerConfig,
  ParsedMcpConfig,
} from '../types';
import { DEFAULT_MCP_SERVER, isValidMcpServerConfig } from '../types';
import type { VaultFileAdapter } from './VaultFileAdapter';

/** Path to MCP config file relative to vault root. */
export const MCP_CONFIG_PATH = '.claude/mcp.json';

/** Absolute path to the user-level Claude Code settings file containing global MCP servers. */
export const GLOBAL_MCP_SETTINGS_PATH = path.join(os.homedir(), '.claude', 'settings.json');

export class McpStorage {
  constructor(private adapter: VaultFileAdapter) { }

  async load(): Promise<ClaudianMcpServer[]> {
    let vaultServers: ClaudianMcpServer[] = [];

    try {
      if (!(await this.adapter.exists(MCP_CONFIG_PATH))) {
        // Fall through to global loading below
      } else {
        const content = await this.adapter.read(MCP_CONFIG_PATH);
        const file = JSON.parse(content) as ClaudianMcpConfigFile;

        if (file.mcpServers && typeof file.mcpServers === 'object') {
          const claudianMeta = file._claudian?.servers ?? {};

          for (const [name, config] of Object.entries(file.mcpServers)) {
            if (!isValidMcpServerConfig(config)) {
              continue;
            }

            const meta = claudianMeta[name] ?? {};
            const disabledTools = Array.isArray(meta.disabledTools)
              ? meta.disabledTools.filter((tool) => typeof tool === 'string')
              : undefined;
            const normalizedDisabledTools =
              disabledTools && disabledTools.length > 0 ? disabledTools : undefined;

            vaultServers.push({
              name,
              config,
              enabled: meta.enabled ?? DEFAULT_MCP_SERVER.enabled,
              contextSaving: meta.contextSaving ?? DEFAULT_MCP_SERVER.contextSaving,
              disabledTools: normalizedDisabledTools,
              description: meta.description,
            });
          }
        }
      }
    } catch {
      // Non-critical: return whatever vault servers could be loaded
    }

    // Append global servers outside the vault try/catch (vault wins on name collision)
    const vaultNames = new Set(vaultServers.map(s => s.name));
    for (const globalServer of this.loadGlobal()) {
      if (!vaultNames.has(globalServer.name)) {
        vaultServers.push(globalServer);
      }
    }

    return vaultServers;
  }


  /**
   * Load MCP servers from the user-level ~/.claude/settings.json.
   * These are read-only from Claudian's perspective (CC owns the file).
   */
  private loadGlobal(): ClaudianMcpServer[] {
    try {
      if (!fs.existsSync(GLOBAL_MCP_SETTINGS_PATH)) return [];

      const content = fs.readFileSync(GLOBAL_MCP_SETTINGS_PATH, 'utf-8');
      const settings = JSON.parse(content) as Record<string, unknown>;

      const mcpServers = settings.mcpServers;
      if (!mcpServers || typeof mcpServers !== 'object' || Array.isArray(mcpServers)) {
        return [];
      }

      const result: ClaudianMcpServer[] = [];
      for (const [name, config] of Object.entries(mcpServers as Record<string, unknown>)) {
        if (!isValidMcpServerConfig(config)) continue;
        result.push({
          name,
          config: config as McpServerConfig,
          enabled: DEFAULT_MCP_SERVER.enabled,
          contextSaving: DEFAULT_MCP_SERVER.contextSaving,
        });
      }
      return result;
    } catch {
      // Non-critical: global settings file may be absent or malformed
      return [];
    }
  }

  async save(servers: ClaudianMcpServer[]): Promise<void> {
    const mcpServers: Record<string, McpServerConfig> = {};
    const claudianServers: Record<
      string,
      { enabled?: boolean; contextSaving?: boolean; disabledTools?: string[]; description?: string }
    > = {};

    for (const server of servers) {
      mcpServers[server.name] = server.config;

      // Only store Claudian metadata if different from defaults
      const meta: {
        enabled?: boolean;
        contextSaving?: boolean;
        disabledTools?: string[];
        description?: string;
      } = {};

      if (server.enabled !== DEFAULT_MCP_SERVER.enabled) {
        meta.enabled = server.enabled;
      }
      if (server.contextSaving !== DEFAULT_MCP_SERVER.contextSaving) {
        meta.contextSaving = server.contextSaving;
      }
      const normalizedDisabledTools = server.disabledTools
        ?.map((tool) => tool.trim())
        .filter((tool) => tool.length > 0);
      if (normalizedDisabledTools && normalizedDisabledTools.length > 0) {
        meta.disabledTools = normalizedDisabledTools;
      }
      if (server.description) {
        meta.description = server.description;
      }

      if (Object.keys(meta).length > 0) {
        claudianServers[server.name] = meta;
      }
    }

    let existing: Record<string, unknown> | null = null;
    if (await this.adapter.exists(MCP_CONFIG_PATH)) {
      try {
        const raw = await this.adapter.read(MCP_CONFIG_PATH);
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') {
          existing = parsed as Record<string, unknown>;
        }
      } catch {
        existing = null;
      }
    }

    const file: Record<string, unknown> = existing ? { ...existing } : {};
    file.mcpServers = mcpServers;

    const existingClaudian =
      existing && typeof existing._claudian === 'object'
        ? (existing._claudian as Record<string, unknown>)
        : null;

    if (Object.keys(claudianServers).length > 0) {
      file._claudian = { ...(existingClaudian ?? {}), servers: claudianServers };
    } else if (existingClaudian) {
      const { servers: _servers, ...rest } = existingClaudian;
      if (Object.keys(rest).length > 0) {
        file._claudian = rest;
      } else {
        delete file._claudian;
      }
    } else {
      delete file._claudian;
    }

    const content = JSON.stringify(file, null, 2);
    await this.adapter.write(MCP_CONFIG_PATH, content);
  }

  async exists(): Promise<boolean> {
    return this.adapter.exists(MCP_CONFIG_PATH);
  }

  /**
   * Parse pasted JSON (supports multiple formats).
   *
   * Formats supported:
   * 1. Full Claude Code format: { "mcpServers": { "name": {...} } }
   * 2. Single server with name: { "name": { "command": "..." } }
   * 3. Single server without name: { "command": "..." }
   */
  static parseClipboardConfig(json: string): ParsedMcpConfig {
    try {
      const parsed = JSON.parse(json);

      if (!parsed || typeof parsed !== 'object') {
        throw new Error('Invalid JSON object');
      }

      // Format 1: Full Claude Code format
      // { "mcpServers": { "server-name": { "command": "...", ... } } }
      if (parsed.mcpServers && typeof parsed.mcpServers === 'object') {
        const servers: Array<{ name: string; config: McpServerConfig }> = [];

        for (const [name, config] of Object.entries(parsed.mcpServers)) {
          if (isValidMcpServerConfig(config)) {
            servers.push({ name, config: config as McpServerConfig });
          }
        }

        if (servers.length === 0) {
          throw new Error('No valid server configs found in mcpServers');
        }

        return { servers, needsName: false };
      }

      // Format 2: Single server config without name
      // { "command": "...", "args": [...] } or { "type": "sse", "url": "..." }
      if (isValidMcpServerConfig(parsed)) {
        return {
          servers: [{ name: '', config: parsed as McpServerConfig }],
          needsName: true,
        };
      }

      // Format 3: Single named server
      // { "server-name": { "command": "...", ... } }
      const entries = Object.entries(parsed);
      if (entries.length === 1) {
        const [name, config] = entries[0];
        if (isValidMcpServerConfig(config)) {
          return {
            servers: [{ name, config: config as McpServerConfig }],
            needsName: false,
          };
        }
      }

      // Format 4: Multiple named servers (without mcpServers wrapper)
      // { "server1": {...}, "server2": {...} }
      const servers: Array<{ name: string; config: McpServerConfig }> = [];
      for (const [name, config] of entries) {
        if (isValidMcpServerConfig(config)) {
          servers.push({ name, config: config as McpServerConfig });
        }
      }

      if (servers.length > 0) {
        return { servers, needsName: false };
      }

      throw new Error('Invalid MCP configuration format');
    } catch (error) {
      if (error instanceof SyntaxError) {
        throw new Error('Invalid JSON');
      }
      throw error;
    }
  }

  /**
   * Try to parse clipboard content as MCP config.
   * Returns null if not valid MCP config.
   */
  static tryParseClipboardConfig(text: string): ParsedMcpConfig | null {
    // Quick check - must look like JSON
    const trimmed = text.trim();
    if (!trimmed.startsWith('{')) {
      return null;
    }

    try {
      return McpStorage.parseClipboardConfig(trimmed);
    } catch {
      return null;
    }
  }
}
