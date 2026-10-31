import { parseEnvironmentVariables } from '@/core/process/env';
import { selectWSLForwardedEnvironment, type WSLForwardedVariable } from '@/core/process/execution-target/WSLEnvironment';

/** Claude owns environment names; core owns WSLENV serialization and translation. */
export function getClaudeWSLForwardedEnvironment(
  env: Record<string, string>,
  environmentText: string,
): WSLForwardedVariable[] {
  return selectWSLForwardedEnvironment({
    env, configured: parseEnvironmentVariables(environmentText),
    inheritedKeys: Object.keys(env).filter(key => /^(?:CLAUDE_|ANTHROPIC_|MCP_)/u.test(key)),
    providerPathVariables: [{ key: 'CLAUDE_CONFIG_DIR' }],
  });
}
