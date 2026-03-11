/**
 * Geminian - MCP (Model Context Protocol) type definitions
 *
 * Types for configuring and managing MCP servers that extend Gemini's capabilities.
 */

/** Stdio server configuration (local command-line programs). */
export interface McpStdioServerConfig {
  type?: 'stdio';
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

/** Server-Sent Events remote server configuration. */
export interface McpSSEServerConfig {
  type: 'sse';
  url: string;
  headers?: Record<string, string>;
}

/** HTTP remote server configuration. */
export interface McpHttpServerConfig {
  type: 'http';
  url: string;
  headers?: Record<string, string>;
}

/** Union type for all MCP server configurations. */
export type McpServerConfig =
  | McpStdioServerConfig
  | McpSSEServerConfig
  | McpHttpServerConfig;

/** Server type identifier. */
export type McpServerType = 'stdio' | 'sse' | 'http';

/** Extended server configuration with Geminian-specific options. */
export interface GeminianMcpServer {
  /** Unique server name (key in mcpServers record). */
  name: string;
  config: McpServerConfig;
  enabled: boolean;
  /** Context-saving mode: hide tools unless @-mentioned. */
  contextSaving: boolean;
  /** Tool names disabled for this server. */
  disabledTools?: string[];
  description?: string;
}

/** MCP configuration file format (Gemini CLI compatible). */
export interface McpConfigFile {
  mcpServers: Record<string, McpServerConfig>;
}

/** Extended config file with Geminian metadata. */
export interface GeminianMcpConfigFile extends McpConfigFile {
  _geminian?: {
    /** Per-server Geminian-specific settings. */
    servers: Record<
      string,
      {
        enabled?: boolean;
        contextSaving?: boolean;
        disabledTools?: string[];
        description?: string;
      }
    >;
  };
}

/** Result of parsing clipboard config. */
export interface ParsedMcpConfig {
  servers: Array<{ name: string; config: McpServerConfig }>;
  needsName: boolean;
}

export function getMcpServerType(config: McpServerConfig): McpServerType {
  if (config.type === 'sse') return 'sse';
  if (config.type === 'http') return 'http';
  if ('url' in config) return 'http'; // URL without explicit type defaults to http
  return 'stdio';
}

export function isValidMcpServerConfig(obj: unknown): obj is McpServerConfig {
  if (!obj || typeof obj !== 'object') return false;
  const config = obj as Record<string, unknown>;

  // Check for stdio (command required)
  if (config.command && typeof config.command === 'string') return true;

  // Check for sse/http (url required, type is optional - defaults to http)
  if (config.url && typeof config.url === 'string') return true;

  return false;
}

export const DEFAULT_MCP_SERVER: Omit<GeminianMcpServer, 'name' | 'config'> = {
  enabled: true,
  contextSaving: true,
};
