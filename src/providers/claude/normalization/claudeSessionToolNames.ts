import { SESSION_TOOL_MCP_SERVER_NAME } from '@/core/session-tools/sessionToolMCP';
import { isSessionTool } from '@/core/tools/toolNames';

export const CLAUDE_SESSION_TOOL_PREFIX = `mcp__${SESSION_TOOL_MCP_SERVER_NAME}__`;

export function normalizeClaudeSessionToolName(name: string): string {
  const neutral = name.startsWith(CLAUDE_SESSION_TOOL_PREFIX)
    ? name.slice(CLAUDE_SESSION_TOOL_PREFIX.length)
    : name;
  return isSessionTool(neutral) ? neutral : name;
}
