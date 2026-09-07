import {
isAgentLifecycleTool,
isBashTool,
// Type guards
isEditTool,
isFileTool,
isMcpTool,
isReadOnlyTool,
isWriteEditTool,
TOOL_BASH,
TOOL_CLOSE_AGENT,
TOOL_RESUME_AGENT,
TOOL_SEND_INPUT,
TOOL_SPAWN_AGENT,
TOOL_SUBAGENT,
TOOL_WAIT,
TOOL_WAIT_AGENT
} from '@/core/tools/toolNames';

describe('isAgentLifecycleTool', () => {
  it('should return true for runtime lifecycle tools only', () => {
    expect(isAgentLifecycleTool(TOOL_SPAWN_AGENT)).toBe(true);
    expect(isAgentLifecycleTool(TOOL_SEND_INPUT)).toBe(true);
    expect(isAgentLifecycleTool(TOOL_WAIT)).toBe(true);
    expect(isAgentLifecycleTool(TOOL_WAIT_AGENT)).toBe(true);
    expect(isAgentLifecycleTool(TOOL_RESUME_AGENT)).toBe(true);
    expect(isAgentLifecycleTool(TOOL_CLOSE_AGENT)).toBe(true);
    expect(isAgentLifecycleTool(TOOL_BASH)).toBe(false);
    expect(isAgentLifecycleTool(TOOL_SUBAGENT)).toBe(false);
  });
});

describe('isEditTool', () => {
  it('should return true for Edit tool', () => {
    expect(isEditTool('Edit')).toBe(true);
  });

  it('should return true for Write tool', () => {
    expect(isEditTool('Write')).toBe(true);
  });

  it('should return true for NotebookEdit tool', () => {
    expect(isEditTool('NotebookEdit')).toBe(true);
  });

  it('should return false for Read tool', () => {
    expect(isEditTool('Read')).toBe(false);
  });

  it('should return false for Bash tool', () => {
    expect(isEditTool('Bash')).toBe(false);
  });

  it('should return false for empty string', () => {
    expect(isEditTool('')).toBe(false);
  });

  it('should return false for unknown tool', () => {
    expect(isEditTool('UnknownTool')).toBe(false);
  });

  it('should be case-sensitive', () => {
    expect(isEditTool('edit')).toBe(false);
    expect(isEditTool('EDIT')).toBe(false);
  });
});

describe('isWriteEditTool', () => {
  it('should return true for Write tool', () => {
    expect(isWriteEditTool('Write')).toBe(true);
  });

  it('should return true for Edit tool', () => {
    expect(isWriteEditTool('Edit')).toBe(true);
  });

  it('should return false for NotebookEdit tool', () => {
    expect(isWriteEditTool('NotebookEdit')).toBe(false);
  });

  it('should return false for Read tool', () => {
    expect(isWriteEditTool('Read')).toBe(false);
  });

  it('should return false for empty string', () => {
    expect(isWriteEditTool('')).toBe(false);
  });

  it('should return false for unknown tool', () => {
    expect(isWriteEditTool('UnknownTool')).toBe(false);
  });
});

describe('isFileTool', () => {
  it('should return true for Read tool', () => {
    expect(isFileTool('Read')).toBe(true);
  });

  it('should return true for Write tool', () => {
    expect(isFileTool('Write')).toBe(true);
  });

  it('should return true for Edit tool', () => {
    expect(isFileTool('Edit')).toBe(true);
  });

  it('should return true for Glob tool', () => {
    expect(isFileTool('Glob')).toBe(true);
  });

  it('should return true for Grep tool', () => {
    expect(isFileTool('Grep')).toBe(true);
  });

  it('should return true for LS tool', () => {
    expect(isFileTool('LS')).toBe(true);
  });

  it('should return true for NotebookEdit tool', () => {
    expect(isFileTool('NotebookEdit')).toBe(true);
  });

  it('should return true for Bash tool', () => {
    expect(isFileTool('Bash')).toBe(true);
  });

  it('should return false for WebSearch tool', () => {
    expect(isFileTool('WebSearch')).toBe(false);
  });

  it('should return false for Task tool', () => {
    expect(isFileTool('Task')).toBe(false);
  });

  it('should return false for empty string', () => {
    expect(isFileTool('')).toBe(false);
  });

  it('should return false for unknown tool', () => {
    expect(isFileTool('UnknownTool')).toBe(false);
  });
});

describe('isBashTool', () => {
  it('should return true for Bash tool', () => {
    expect(isBashTool('Bash')).toBe(true);
  });

  it('should return true for BashOutput tool', () => {
    expect(isBashTool('BashOutput')).toBe(true);
  });

  it('should return true for KillShell tool', () => {
    expect(isBashTool('KillShell')).toBe(true);
  });

  it('should return false for Read tool', () => {
    expect(isBashTool('Read')).toBe(false);
  });

  it('should return false for Task tool', () => {
    expect(isBashTool('Task')).toBe(false);
  });

  it('should return false for empty string', () => {
    expect(isBashTool('')).toBe(false);
  });

  it('should return false for unknown tool', () => {
    expect(isBashTool('UnknownTool')).toBe(false);
  });

  it('should be case-sensitive', () => {
    expect(isBashTool('bash')).toBe(false);
    expect(isBashTool('BASH')).toBe(false);
  });
});

describe('isMcpTool', () => {
  it('should return true for ListMcpResources tool', () => {
    expect(isMcpTool('ListMcpResources')).toBe(true);
  });

  it('should return true for ReadMcpResource tool', () => {
    expect(isMcpTool('ReadMcpResource')).toBe(true);
  });

  it('should return true for Mcp tool', () => {
    expect(isMcpTool('Mcp')).toBe(true);
  });

  it('should return false for Read tool', () => {
    expect(isMcpTool('Read')).toBe(false);
  });

  it('should return false for Bash tool', () => {
    expect(isMcpTool('Bash')).toBe(false);
  });

  it('should return false for empty string', () => {
    expect(isMcpTool('')).toBe(false);
  });

  it('should return false for unknown tool', () => {
    expect(isMcpTool('UnknownTool')).toBe(false);
  });

  it('should return false for mcp-prefixed tool name (not in MCP_TOOLS)', () => {
    // MCP tools invoked via SDK have mcp__ prefix but are not in MCP_TOOLS
    expect(isMcpTool('mcp__server__tool')).toBe(false);
  });
});

describe('isReadOnlyTool', () => {
  it('should return true for Read tool', () => {
    expect(isReadOnlyTool('Read')).toBe(true);
  });

  it('should return true for Grep tool', () => {
    expect(isReadOnlyTool('Grep')).toBe(true);
  });

  it('should return true for Glob tool', () => {
    expect(isReadOnlyTool('Glob')).toBe(true);
  });

  it('should return true for LS tool', () => {
    expect(isReadOnlyTool('LS')).toBe(true);
  });

  it('should return true for WebSearch tool', () => {
    expect(isReadOnlyTool('WebSearch')).toBe(true);
  });

  it('should return true for WebFetch tool', () => {
    expect(isReadOnlyTool('WebFetch')).toBe(true);
  });

  it('should return false for Write tool', () => {
    expect(isReadOnlyTool('Write')).toBe(false);
  });

  it('should return false for Edit tool', () => {
    expect(isReadOnlyTool('Edit')).toBe(false);
  });

  it('should return false for Bash tool', () => {
    expect(isReadOnlyTool('Bash')).toBe(false);
  });

  it('should return false for Task tool', () => {
    expect(isReadOnlyTool('Task')).toBe(false);
  });

  it('should return false for empty string', () => {
    expect(isReadOnlyTool('')).toBe(false);
  });

  it('should return false for unknown tool', () => {
    expect(isReadOnlyTool('UnknownTool')).toBe(false);
  });
});
