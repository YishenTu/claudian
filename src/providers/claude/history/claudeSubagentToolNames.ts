import { TOOL_SUBAGENT } from '../../../core/tools/toolNames';

const LEGACY_CLAUDE_SUBAGENT_TOOL = 'Task';

/** Accepts old transcript data at the Claude history boundary only. */
export function isClaudeSubagentToolName(name: string): boolean {
  return name === TOOL_SUBAGENT || name === LEGACY_CLAUDE_SUBAGENT_TOOL;
}
