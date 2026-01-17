/**
 * Tool name constants and helpers.
 *
 * Keeps tool-name strings consistent across the service, view, and UI renderers.
 */

export const TOOL_AGENT_OUTPUT = 'TaskOutput' as const;
export const TOOL_BASH = 'Bash' as const;
export const TOOL_BASH_OUTPUT = 'BashOutput' as const;
export const TOOL_EDIT = 'Edit' as const;
export const TOOL_GLOB = 'Glob' as const;
export const TOOL_GREP = 'Grep' as const;
export const TOOL_KILL_SHELL = 'KillShell' as const;
export const TOOL_LS = 'LS' as const;
export const TOOL_LIST_MCP_RESOURCES = 'ListMcpResources' as const;
export const TOOL_MCP = 'Mcp' as const;
export const TOOL_NOTEBOOK_EDIT = 'NotebookEdit' as const;
export const TOOL_READ = 'Read' as const;
export const TOOL_READ_MCP_RESOURCE = 'ReadMcpResource' as const;
export const TOOL_SKILL = 'Skill' as const;
export const TOOL_TASK = 'Task' as const;
export const TOOL_TODO_WRITE = 'TodoWrite' as const;
export const TOOL_WEB_FETCH = 'WebFetch' as const;
export const TOOL_WEB_SEARCH = 'WebSearch' as const;
export const TOOL_WRITE = 'Write' as const;

export const EDIT_TOOLS = [TOOL_WRITE, TOOL_EDIT, TOOL_NOTEBOOK_EDIT] as const;
export type EditToolName = (typeof EDIT_TOOLS)[number];

export const WRITE_EDIT_TOOLS = [TOOL_WRITE, TOOL_EDIT] as const;
export type WriteEditToolName = (typeof WRITE_EDIT_TOOLS)[number];

export const BASH_TOOLS = [TOOL_BASH, TOOL_BASH_OUTPUT, TOOL_KILL_SHELL] as const;
export type BashToolName = (typeof BASH_TOOLS)[number];

export const FILE_TOOLS = [
  TOOL_READ,
  TOOL_WRITE,
  TOOL_EDIT,
  TOOL_GLOB,
  TOOL_GREP,
  TOOL_LS,
  TOOL_NOTEBOOK_EDIT,
  TOOL_BASH,
] as const;
export type FileToolName = (typeof FILE_TOOLS)[number];

export const MCP_TOOLS = [
  TOOL_LIST_MCP_RESOURCES,
  TOOL_READ_MCP_RESOURCE,
  TOOL_MCP,
] as const;
export type McpToolName = (typeof MCP_TOOLS)[number];

export const READ_ONLY_TOOLS = [
  TOOL_READ,
  TOOL_GREP,
  TOOL_GLOB,
  TOOL_LS,
  TOOL_WEB_SEARCH,
  TOOL_WEB_FETCH,
] as const;
export type ReadOnlyToolName = (typeof READ_ONLY_TOOLS)[number];

export function isEditTool(toolName: string): toolName is EditToolName {
  return (EDIT_TOOLS as readonly string[]).includes(toolName);
}

export function isWriteEditTool(toolName: string): toolName is WriteEditToolName {
  return (WRITE_EDIT_TOOLS as readonly string[]).includes(toolName);
}

export function isFileTool(toolName: string): toolName is FileToolName {
  return (FILE_TOOLS as readonly string[]).includes(toolName);
}

export function isBashTool(toolName: string): toolName is BashToolName {
  return (BASH_TOOLS as readonly string[]).includes(toolName);
}

export function isMcpTool(toolName: string): toolName is McpToolName {
  return (MCP_TOOLS as readonly string[]).includes(toolName);
}

export function isReadOnlyTool(toolName: string): toolName is ReadOnlyToolName {
  return (READ_ONLY_TOOLS as readonly string[]).includes(toolName);
}
