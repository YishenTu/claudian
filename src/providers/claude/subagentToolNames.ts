import { TOOL_SUBAGENT } from '../../core/tools/toolNames';

/** Recognizes the native Claude subagent tool. */
export function isClaudeSubagentToolName(name: string): boolean {
  return name === TOOL_SUBAGENT;
}
