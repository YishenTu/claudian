export const GROK_SUBAGENT_SPAWN_TOOL_NAMES = [
  'spawn_subagent',
  'task',
] as const;

export const GROK_SUBAGENT_WAIT_TOOL_NAMES = [
  'get_command_or_subagent_output',
  'task_output',
  'wait_commands_or_subagents',
  'wait_for_task',
] as const;

export const GROK_SUBAGENT_CLOSE_TOOL_NAMES = [
  'kill_command_or_subagent',
  'kill_task',
] as const;

export const GROK_SUBAGENT_LIFECYCLE_TOOL_NAMES: ReadonlySet<string> = new Set([
  ...GROK_SUBAGENT_SPAWN_TOOL_NAMES,
  ...GROK_SUBAGENT_WAIT_TOOL_NAMES,
  ...GROK_SUBAGENT_CLOSE_TOOL_NAMES,
]);
