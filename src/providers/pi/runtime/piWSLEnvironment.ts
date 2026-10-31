import { parseEnvironmentVariables } from '@/core/process/env';
import { selectWSLForwardedEnvironment, type WSLForwardedVariable } from '@/core/process/execution-target/WSLEnvironment';

export function getPiWSLForwardedEnvironment(env: NodeJS.ProcessEnv, environmentText: string): WSLForwardedVariable[] {
  return selectWSLForwardedEnvironment({
    env, configured: parseEnvironmentVariables(environmentText),
    inheritedKeys: Object.keys(env).filter(key => /^PI_/u.test(key)),
    providerPathVariables: [{ key: 'PI_CODING_AGENT_DIR' }, { key: 'PI_CODING_AGENT_SESSION_DIR' }, { key: 'PI_PACKAGE_DIR' }],
  });
}
