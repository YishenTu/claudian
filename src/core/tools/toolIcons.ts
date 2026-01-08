/**
 * Tool icon helpers.
 *
 * Centralizes the mapping between tool names and Lucide icon IDs.
 */

import {
  TOOL_AGENT_OUTPUT,
  TOOL_BASH,
  TOOL_BASH_OUTPUT,
  TOOL_EDIT,
  TOOL_GLOB,
  TOOL_GREP,
  TOOL_KILL_SHELL,
  TOOL_LIST_MCP_RESOURCES,
  TOOL_LS,
  TOOL_MCP,
  TOOL_NOTEBOOK_EDIT,
  TOOL_READ,
  TOOL_READ_MCP_RESOURCE,
  TOOL_SKILL,
  TOOL_TASK,
  TOOL_TODO_WRITE,
  TOOL_WEB_FETCH,
  TOOL_WEB_SEARCH,
  TOOL_WRITE,
} from './toolNames';

const TOOL_ICONS: Record<string, string> = {
  [TOOL_READ]: 'file-text',
  [TOOL_WRITE]: 'edit-3',
  [TOOL_EDIT]: 'edit',
  [TOOL_NOTEBOOK_EDIT]: 'edit',
  [TOOL_BASH]: 'terminal',
  [TOOL_BASH_OUTPUT]: 'terminal',
  [TOOL_KILL_SHELL]: 'terminal',
  [TOOL_GLOB]: 'folder-search',
  [TOOL_GREP]: 'search',
  [TOOL_LS]: 'list',
  [TOOL_TODO_WRITE]: 'list-checks',
  [TOOL_TASK]: 'list-checks',
  [TOOL_LIST_MCP_RESOURCES]: 'list',
  [TOOL_READ_MCP_RESOURCE]: 'file-text',
  [TOOL_MCP]: 'wrench',
  [TOOL_WEB_SEARCH]: 'globe',
  [TOOL_WEB_FETCH]: 'download',
  [TOOL_AGENT_OUTPUT]: 'bot',
  [TOOL_SKILL]: 'zap',
};

/** Special marker for MCP tools - signals to use custom SVG. */
export const MCP_ICON_MARKER = '__mcp_icon__';

export function getToolIcon(toolName: string): string {
  // MCP tools start with "mcp__" prefix
  if (toolName.startsWith('mcp__')) {
    return MCP_ICON_MARKER;
  }
  return TOOL_ICONS[toolName] || 'wrench';
}
