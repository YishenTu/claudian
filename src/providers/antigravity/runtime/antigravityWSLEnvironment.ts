import { parseEnvironmentVariables } from '@/core/process/env';
import { selectWSLForwardedEnvironment, type WSLForwardedVariable } from '@/core/process/execution-target/WSLEnvironment';

/** Antigravity owns the meaning of its environment; core owns WSLENV encoding. */
export function getAntigravityWSLForwardedEnvironment(env: Record<string, string>, environmentText: string): WSLForwardedVariable[] {
  return selectWSLForwardedEnvironment({
    env, configured: parseEnvironmentVariables(environmentText),
    inheritedKeys: Object.keys(env).filter(key => /^(?:AGY_|ANTIGRAVITY_|GEMINI_)/u.test(key)),
    providerPathVariables: [],
  });
}
