import { parseEnvironmentVariables } from '@/core/process/env';
import type { WSLForwardedVariable } from '@/core/process/execution-target/WSLEnvironment';

const PATH_KEYS = new Set(['PI_CODING_AGENT_DIR', 'PI_CODING_AGENT_SESSION_DIR', 'PI_PACKAGE_DIR']);

export function getPiWSLForwardedEnvironment(env: NodeJS.ProcessEnv, environmentText: string): WSLForwardedVariable[] {
  const configured = parseEnvironmentVariables(environmentText);
  const keys = new Set([...Object.keys(configured), ...Object.keys(env).filter(key => key.startsWith('PI_'))]);
  return [...keys].filter(key => {
    if (['HOME', 'PATH', 'USERPROFILE'].includes(key)) {
      return key !== 'USERPROFILE' && configured[key]?.startsWith('/') && !configured[key].includes('\\');
    }
    return key !== 'WSLENV';
  }).map(key => ({ key, hostPath: PATH_KEYS.has(key) && /^(?:[a-zA-Z]:[\\/]|[\\/]{2})/u.test(env[key] ?? '') }));
}
