import {
isAgentLifecycleTool,
// Type guards
isEditTool,
isReadOnlyTool,
isSessionTool,
isWriteEditTool,
TOOL_BASH,
TOOL_CLAUDIAN_LIST_DESTINATIONS,
TOOL_CLAUDIAN_SEND_MESSAGE,
TOOL_CLOSE_AGENT,
TOOL_RESUME_AGENT,
TOOL_SEND_INPUT,
TOOL_SEND_MESSAGE,
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

describe('isSessionTool', () => {
  it('matches only the Claudian session tools, distinct from runtime agent messaging', () => {
    expect(TOOL_CLAUDIAN_LIST_DESTINATIONS).toBe('claudian_list_destinations');
    expect(TOOL_CLAUDIAN_SEND_MESSAGE).toBe('claudian_send_message');
    expect(isSessionTool(TOOL_CLAUDIAN_LIST_DESTINATIONS)).toBe(true);
    expect(isSessionTool(TOOL_CLAUDIAN_SEND_MESSAGE)).toBe(true);
    expect(isSessionTool(TOOL_SEND_MESSAGE)).toBe(false);
    expect(isAgentLifecycleTool(TOOL_CLAUDIAN_SEND_MESSAGE)).toBe(false);
    expect(isSessionTool('mcp__claudian_sessions__claudian_send_message')).toBe(false);
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
