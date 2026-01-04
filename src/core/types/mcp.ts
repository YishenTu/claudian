/**
 * Claudian - MCP (Model Context Protocol) type definitions
 *
 * Types for configuring and managing MCP servers that extend Claude's capabilities.
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

/** Extended server configuration with Claudian-specific options. */
export interface ClaudianMcpServer {
  /** Unique server name (key in mcpServers record). */
  name: string;
  /** Server configuration. */
  config: McpServerConfig;
  /** Whether the server is enabled. */
  enabled: boolean;
  /** Context-saving mode: hide tools unless @-mentioned. */
  contextSaving: boolean;
  /** Tool names disabled for this server. */
  disabledTools?: string[];
  /** Optional description for UI display. */
  description?: string;
}

/** MCP configuration file format (Claude Code compatible). */
export interface McpConfigFile {
  mcpServers: Record<string, McpServerConfig>;
}

/** Extended config file with Claudian metadata. */
export interface ClaudianMcpConfigFile extends McpConfigFile {
  _claudian?: {
    /** Per-server Claudian-specific settings. */
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

/** Get the type of an MCP server config. */
export function getMcpServerType(config: McpServerConfig): McpServerType {
  if (config.type === 'sse') return 'sse';
  if (config.type === 'http') return 'http';
  if ('url' in config) return 'http'; // URL without explicit type defaults to http
  return 'stdio';
}

/** Check if a value is a valid MCP server config. */
export function isValidMcpServerConfig(obj: unknown): obj is McpServerConfig {
  if (!obj || typeof obj !== 'object') return false;
  const config = obj as Record<string, unknown>;

  // Check for stdio (command required)
  if (config.command && typeof config.command === 'string') return true;

  // Check for sse/http (url required, type is optional - defaults to http)
  if (config.url && typeof config.url === 'string') return true;

  return false;
}

/** Infer the server type from a config. */
export function inferMcpServerType(config: McpServerConfig): McpServerType {
  if (config.type === 'sse') return 'sse';
  if (config.type === 'http') return 'http';
  if ('url' in config) return 'http'; // Default URL-based to http
  return 'stdio';
}

/** Default values for a new MCP server. */
export const DEFAULT_MCP_SERVER: Omit<ClaudianMcpServer, 'name' | 'config'> = {
  enabled: true,
  contextSaving: true,
};
