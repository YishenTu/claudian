import { getToolIcon, MCP_ICON_MARKER } from '@/core/tools/toolIcons';
import {
  TOOL_AGENT_OUTPUT,
  TOOL_ASK_USER_QUESTION,
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
} from '@/core/tools/toolNames';

describe('MCP_ICON_MARKER', () => {
  it('should be defined as a special marker string', () => {
    expect(MCP_ICON_MARKER).toBe('__mcp_icon__');
  });
});

describe('getToolIcon', () => {
  it.each([
    [TOOL_READ, 'file-text'],
    [TOOL_WRITE, 'file-plus'],
    [TOOL_EDIT, 'file-pen'],
    [TOOL_NOTEBOOK_EDIT, 'file-pen'],
    [TOOL_BASH, 'terminal'],
    [TOOL_BASH_OUTPUT, 'terminal'],
    [TOOL_KILL_SHELL, 'terminal'],
    [TOOL_GLOB, 'folder-search'],
    [TOOL_GREP, 'search'],
    [TOOL_LS, 'list'],
    [TOOL_TODO_WRITE, 'list-checks'],
    [TOOL_TASK, 'bot'],
    [TOOL_LIST_MCP_RESOURCES, 'list'],
    [TOOL_READ_MCP_RESOURCE, 'file-text'],
    [TOOL_MCP, 'wrench'],
    [TOOL_WEB_SEARCH, 'globe'],
    [TOOL_WEB_FETCH, 'download'],
    [TOOL_AGENT_OUTPUT, 'bot'],
    [TOOL_ASK_USER_QUESTION, 'help-circle'],
    [TOOL_SKILL, 'zap'],
  ])('should return "%s" icon for %s tool', (tool, expectedIcon) => {
    expect(getToolIcon(tool)).toBe(expectedIcon);
  });

  it('should return MCP_ICON_MARKER for mcp__ prefixed tools', () => {
    expect(getToolIcon('mcp__server__tool')).toBe(MCP_ICON_MARKER);
    expect(getToolIcon('mcp__github__search')).toBe(MCP_ICON_MARKER);
    expect(getToolIcon('mcp__')).toBe(MCP_ICON_MARKER);
  });

  it('should return fallback wrench icon for unknown tools', () => {
    expect(getToolIcon('UnknownTool')).toBe('wrench');
    expect(getToolIcon('')).toBe('wrench');
    expect(getToolIcon('SomeCustomTool')).toBe('wrench');
  });

  it('should not match partial mcp prefix', () => {
    expect(getToolIcon('mcpTool')).toBe('wrench');
    expect(getToolIcon('mcp_single_underscore')).toBe('wrench');
  });
});
