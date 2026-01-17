import {
  BASH_TOOLS,
  // Tool arrays
  EDIT_TOOLS,
  FILE_TOOLS,
  isBashTool,
  // Type guards
  isEditTool,
  isFileTool,
  isMcpTool,
  isReadOnlyTool,
  isWriteEditTool,
  MCP_TOOLS,
  READ_ONLY_TOOLS,
  // Constants
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
  WRITE_EDIT_TOOLS,
} from '@/core/tools/toolNames';

describe('Tool Constants', () => {
  it('should export all tool name constants', () => {
    expect(TOOL_AGENT_OUTPUT).toBe('TaskOutput');
    expect(TOOL_BASH).toBe('Bash');
    expect(TOOL_BASH_OUTPUT).toBe('BashOutput');
    expect(TOOL_EDIT).toBe('Edit');
    expect(TOOL_GLOB).toBe('Glob');
    expect(TOOL_GREP).toBe('Grep');
    expect(TOOL_KILL_SHELL).toBe('KillShell');
    expect(TOOL_LS).toBe('LS');
    expect(TOOL_LIST_MCP_RESOURCES).toBe('ListMcpResources');
    expect(TOOL_MCP).toBe('Mcp');
    expect(TOOL_NOTEBOOK_EDIT).toBe('NotebookEdit');
    expect(TOOL_READ).toBe('Read');
    expect(TOOL_READ_MCP_RESOURCE).toBe('ReadMcpResource');
    expect(TOOL_SKILL).toBe('Skill');
    expect(TOOL_TASK).toBe('Task');
    expect(TOOL_TODO_WRITE).toBe('TodoWrite');
    expect(TOOL_WEB_FETCH).toBe('WebFetch');
    expect(TOOL_WEB_SEARCH).toBe('WebSearch');
    expect(TOOL_WRITE).toBe('Write');
  });
});

describe('Tool Arrays', () => {
  describe('EDIT_TOOLS', () => {
    it('should contain Write, Edit, and NotebookEdit', () => {
      expect(EDIT_TOOLS).toContain('Write');
      expect(EDIT_TOOLS).toContain('Edit');
      expect(EDIT_TOOLS).toContain('NotebookEdit');
      expect(EDIT_TOOLS).toHaveLength(3);
    });
  });

  describe('WRITE_EDIT_TOOLS', () => {
    it('should contain Write and Edit only', () => {
      expect(WRITE_EDIT_TOOLS).toContain('Write');
      expect(WRITE_EDIT_TOOLS).toContain('Edit');
      expect(WRITE_EDIT_TOOLS).toHaveLength(2);
    });
  });

  describe('BASH_TOOLS', () => {
    it('should contain Bash, BashOutput, and KillShell', () => {
      expect(BASH_TOOLS).toContain('Bash');
      expect(BASH_TOOLS).toContain('BashOutput');
      expect(BASH_TOOLS).toContain('KillShell');
      expect(BASH_TOOLS).toHaveLength(3);
    });
  });

  describe('FILE_TOOLS', () => {
    it('should contain all file-related tools', () => {
      expect(FILE_TOOLS).toContain('Read');
      expect(FILE_TOOLS).toContain('Write');
      expect(FILE_TOOLS).toContain('Edit');
      expect(FILE_TOOLS).toContain('Glob');
      expect(FILE_TOOLS).toContain('Grep');
      expect(FILE_TOOLS).toContain('LS');
      expect(FILE_TOOLS).toContain('NotebookEdit');
      expect(FILE_TOOLS).toContain('Bash');
      expect(FILE_TOOLS).toHaveLength(8);
    });
  });

  describe('MCP_TOOLS', () => {
    it('should contain all MCP-related tools', () => {
      expect(MCP_TOOLS).toContain('ListMcpResources');
      expect(MCP_TOOLS).toContain('ReadMcpResource');
      expect(MCP_TOOLS).toContain('Mcp');
      expect(MCP_TOOLS).toHaveLength(3);
    });
  });

  describe('READ_ONLY_TOOLS', () => {
    it('should contain all read-only tools', () => {
      expect(READ_ONLY_TOOLS).toContain('Read');
      expect(READ_ONLY_TOOLS).toContain('Grep');
      expect(READ_ONLY_TOOLS).toContain('Glob');
      expect(READ_ONLY_TOOLS).toContain('LS');
      expect(READ_ONLY_TOOLS).toContain('WebSearch');
      expect(READ_ONLY_TOOLS).toContain('WebFetch');
      expect(READ_ONLY_TOOLS).toHaveLength(6);
    });

    it('should not contain write tools', () => {
      expect(READ_ONLY_TOOLS).not.toContain('Write');
      expect(READ_ONLY_TOOLS).not.toContain('Edit');
      expect(READ_ONLY_TOOLS).not.toContain('Bash');
    });
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
