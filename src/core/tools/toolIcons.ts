import {
  TOOL_AGENT_OUTPUT,
  TOOL_APPLY_PATCH,
  TOOL_ASK_USER_QUESTION,
  TOOL_BASH,
  TOOL_BASH_OUTPUT,
  TOOL_CLOSE_AGENT,
  TOOL_EDIT,
  TOOL_ENTER_PLAN_MODE,
  TOOL_EXIT_PLAN_MODE,
  TOOL_GLOB,
  TOOL_GREP,
  TOOL_KILL_SHELL,
  TOOL_LIST_MCP_RESOURCES,
  TOOL_LS,
  TOOL_MCP,
  TOOL_NOTEBOOK_EDIT,
  TOOL_READ,
  TOOL_READ_MCP_RESOURCE,
  TOOL_RESUME_AGENT,
  TOOL_SEND_INPUT,
  TOOL_SKILL,
  TOOL_SPAWN_AGENT,
  TOOL_SUBAGENT_LEGACY,
  TOOL_TASK,
  TOOL_TODO_WRITE,
  TOOL_TOOL_SEARCH,
  TOOL_WAIT,
  TOOL_WAIT_AGENT,
  TOOL_WEB_FETCH,
  TOOL_WEB_SEARCH,
  TOOL_WRITE,
  TOOL_WRITE_STDIN,
} from './toolNames';

const TOOL_ICONS: Record<string, string> = {
  [TOOL_READ]: 'file-text',
  [TOOL_WRITE]: 'file-plus',
  [TOOL_EDIT]: 'file-pen',
  [TOOL_NOTEBOOK_EDIT]: 'file-pen',
  [TOOL_BASH]: 'terminal',
  [TOOL_BASH_OUTPUT]: 'terminal',
  [TOOL_KILL_SHELL]: 'terminal',
  [TOOL_GLOB]: 'folder-search',
  [TOOL_GREP]: 'search',
  [TOOL_LS]: 'list',
  [TOOL_TODO_WRITE]: 'list-checks',
  [TOOL_TASK]: 'bot',
  [TOOL_SUBAGENT_LEGACY]: 'bot',
  [TOOL_LIST_MCP_RESOURCES]: 'list',
  [TOOL_READ_MCP_RESOURCE]: 'file-text',
  [TOOL_MCP]: 'wrench',
  [TOOL_WEB_SEARCH]: 'globe',
  [TOOL_WEB_FETCH]: 'download',
  [TOOL_AGENT_OUTPUT]: 'bot',
  [TOOL_ASK_USER_QUESTION]: 'help-circle',
  [TOOL_SKILL]: 'zap',
  [TOOL_TOOL_SEARCH]: 'search-check',
  [TOOL_ENTER_PLAN_MODE]: 'map',
  [TOOL_EXIT_PLAN_MODE]: 'check-circle',
  // Runtime-managed tools
  [TOOL_APPLY_PATCH]: 'file-pen',
  [TOOL_WRITE_STDIN]: 'terminal',
  [TOOL_SPAWN_AGENT]: 'bot',
  [TOOL_SEND_INPUT]: 'bot',
  [TOOL_WAIT]: 'clock',
  [TOOL_WAIT_AGENT]: 'clock',
  [TOOL_RESUME_AGENT]: 'bot',
  [TOOL_CLOSE_AGENT]: 'bot',
};

/** Special marker for MCP tools - signals to use custom SVG. */
export const MCP_ICON_MARKER = '__mcp_icon__';

export function getToolIcon(toolName: string): string {
  if (toolName.startsWith('mcp__')) {
    return MCP_ICON_MARKER;
  }
  return TOOL_ICONS[toolName] || 'wrench';
}
