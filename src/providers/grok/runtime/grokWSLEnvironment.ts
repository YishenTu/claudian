import { parseEnvironmentVariables } from '@/core/process/env';
import { selectWSLForwardedEnvironment, type WSLForwardedVariable } from '@/core/process/execution-target/WSLEnvironment';

/** Grok owns the meaning of its environment; core owns WSLENV encoding. */
export function getGrokWSLForwardedEnvironment(env: Record<string, string>, environmentText: string): WSLForwardedVariable[] {
  return selectWSLForwardedEnvironment({
    env, configured: parseEnvironmentVariables(environmentText),
    inheritedKeys: Object.keys(env).filter(key => /^(?:GROK_|XAI_)/u.test(key)),
    providerPathVariables: [{ key: 'GROK_HOME' }],
  });
}
