// Legacy history compatibility (2026-09-29, SDK 0.3.283): "the TaskOutput tool was removed",
// so only transcripts recorded before the removal contain it.
export const TOOL_AGENT_OUTPUT = 'TaskOutput' as const;
export const TOOL_ASK_USER_QUESTION = 'AskUserQuestion' as const;
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
export const TOOL_SUBAGENT = 'Agent' as const;
export const TOOL_TODO_WRITE = 'TodoWrite' as const;
export const TOOL_TOOL_SEARCH = 'ToolSearch' as const;
export const TOOL_WEB_FETCH = 'WebFetch' as const;
export const TOOL_WEB_SEARCH = 'WebSearch' as const;
export const TOOL_WRITE = 'Write' as const;

export const TOOL_ENTER_PLAN_MODE = 'EnterPlanMode' as const;
export const TOOL_EXIT_PLAN_MODE = 'ExitPlanMode' as const;

// Runtime-managed tools exposed through provider adapters.
export const TOOL_EXEC = 'exec' as const;
export const TOOL_GENERATE_IMAGE = 'GenerateImage' as const;
export const TOOL_EDIT_IMAGE = 'EditImage' as const;
export const TOOL_GENERATE_VIDEO = 'GenerateVideo' as const;
/** Script that orchestrates agents; presented with its source like other script tools. */
export const TOOL_WORKFLOW = 'Workflow' as const;
export const TOOL_APPLY_PATCH = 'apply_patch' as const;
export const TOOL_WRITE_STDIN = 'write_stdin' as const;
export const TOOL_SPAWN_AGENT = 'spawn_agent' as const;
export const TOOL_SEND_INPUT = 'send_input' as const;
export const TOOL_SEND_MESSAGE = 'send_message' as const;
export const TOOL_FOLLOWUP_TASK = 'followup_task' as const;
export const TOOL_LIST_AGENTS = 'list_agents' as const;
export const TOOL_INTERRUPT_AGENT = 'interrupt_agent' as const;
export const TOOL_WAIT = 'wait' as const;
export const TOOL_WAIT_AGENT = 'wait_agent' as const;
export const TOOL_RESUME_AGENT = 'resume_agent' as const;
export const TOOL_CLOSE_AGENT = 'close_agent' as const;

const SCRIPT_TOOLS: readonly string[] = [TOOL_EXEC, 'js', 'mcp__cua_repl__js', TOOL_WORKFLOW];

export function isScriptTool(name: string): boolean {
  return SCRIPT_TOOLS.includes(name);
}

export const AGENT_LIFECYCLE_TOOLS = [
  TOOL_SPAWN_AGENT,
  TOOL_SEND_INPUT,
  TOOL_SEND_MESSAGE,
  TOOL_FOLLOWUP_TASK,
  TOOL_LIST_AGENTS,
  TOOL_INTERRUPT_AGENT,
  TOOL_WAIT,
  TOOL_WAIT_AGENT,
  TOOL_RESUME_AGENT,
  TOOL_CLOSE_AGENT,
] as const;

export function isAgentLifecycleTool(name: string): boolean {
  return (AGENT_LIFECYCLE_TOOLS as readonly string[]).includes(name);
}

export const EDIT_TOOLS = [TOOL_WRITE, TOOL_EDIT, TOOL_NOTEBOOK_EDIT] as const;
export type EditToolName = (typeof EDIT_TOOLS)[number];

export const WRITE_EDIT_TOOLS = [TOOL_WRITE, TOOL_EDIT] as const;
export type WriteEditToolName = (typeof WRITE_EDIT_TOOLS)[number];

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

export function isReadOnlyTool(toolName: string): toolName is ReadOnlyToolName {
  return (READ_ONLY_TOOLS as readonly string[]).includes(toolName);
}
