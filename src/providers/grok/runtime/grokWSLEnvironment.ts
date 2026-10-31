import { parseEnvironmentVariables } from '@/core/process/env';
import type { WSLForwardedVariable } from '@/core/process/execution-target/WSLEnvironment';

const PATH_KEYS = new Set(['GROK_HOME', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS', 'TMPDIR', 'TMP', 'TEMP']);

/** Grok owns the meaning of its environment; core owns WSLENV encoding. */
export function getGrokWSLForwardedEnvironment(env: Record<string, string>, environmentText: string): WSLForwardedVariable[] {
  const configured = parseEnvironmentVariables(environmentText);
  const keys = new Set([...Object.keys(configured), ...Object.keys(env).filter(key => /^(?:GROK_|XAI_)/u.test(key))]);
  return [...keys].filter(key => {
    if (['HOME', 'PATH', 'USERPROFILE'].includes(key)) {
      return key !== 'USERPROFILE' && configured[key]?.startsWith('/') && !configured[key].includes('\\');
    }
    return key !== 'WSLENV';
  }).map(key => {
    const hostPath = PATH_KEYS.has(key) && /^(?:[a-zA-Z]:[\\/]|[\\/]{2})/u.test(env[key] ?? '');
    return { key, hostPath, pathList: hostPath && key === 'SSL_CERT_DIR' };
  });
}
