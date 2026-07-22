import { TOOL_SUBAGENT } from '../../core/tools/toolNames';

const LEGACY_CLAUDE_SUBAGENT_TOOL = 'Task';

/** Accepts current and legacy subagent names at Claude provider boundaries. */
export function isClaudeSubagentToolName(name: string): boolean {
  return name === TOOL_SUBAGENT || name === LEGACY_CLAUDE_SUBAGENT_TOOL;
}
