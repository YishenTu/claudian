/** MCP (Model Context Protocol) type definitions used by the shared manager/UI. */

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

/** Managed MCP server configuration with UI/runtime metadata. */
export interface ManagedMcpServer {
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

/** MCP configuration file format used by the current CLI integrations. */
export interface McpConfigFile {
  mcpServers: Record<string, McpServerConfig>;
}

/** Extended config file with app-owned server metadata. */
export interface ManagedMcpConfigFile extends McpConfigFile {
  _claudian?: {
    /** Per-server UI/runtime settings. */
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

export const DEFAULT_MCP_SERVER: Omit<ManagedMcpServer, 'name' | 'config'> = {
  enabled: true,
  contextSaving: true,
};
