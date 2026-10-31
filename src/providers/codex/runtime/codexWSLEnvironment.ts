import { parseEnvironmentVariables } from '@/core/process/env';
import { selectWSLForwardedEnvironment, type WSLForwardedVariable } from '@/core/process/execution-target/WSLEnvironment';

export function getCodexWSLForwardedEnvironment(
  env: Record<string, string>,
  environmentText: string,
): WSLForwardedVariable[] {
  return selectWSLForwardedEnvironment({
    env, configured: parseEnvironmentVariables(environmentText),
    inheritedKeys: Object.keys(env).filter(key => /^(?:CODEX_|OPENAI_)/u.test(key)),
    providerPathVariables: [{ key: 'CODEX_HOME' }, { key: 'CODEX_RUNTIME_DEPENDENCIES' }, { key: 'CODEX_WORKSPACE_DEPENDENCIES' }, { key: 'CODEX_DEPENDENCIES' }],
  });
}
