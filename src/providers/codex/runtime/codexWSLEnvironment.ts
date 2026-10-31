import { parseEnvironmentVariables } from '@/core/process/env';
import type { WSLForwardedVariable } from '@/core/process/execution-target/WSLEnvironment';

const PATH_KEYS = new Set([
  'CODEX_HOME', 'CODEX_RUNTIME_DEPENDENCIES', 'CODEX_WORKSPACE_DEPENDENCIES', 'CODEX_DEPENDENCIES',
  'SSL_CERT_FILE', 'SSL_CERT_DIR', 'REQUESTS_CA_BUNDLE', 'CURL_CA_BUNDLE', 'NODE_EXTRA_CA_CERTS',
  'TMPDIR', 'TMP', 'TEMP',
]);

export function getCodexWSLForwardedEnvironment(
  env: Record<string, string>,
  environmentText: string,
): WSLForwardedVariable[] {
  const configured = parseEnvironmentVariables(environmentText);
  const keys = new Set([...Object.keys(configured), ...Object.keys(env).filter(key => /^(?:CODEX_|OPENAI_)/u.test(key))]);
  return [...keys].filter(key => {
    // Only explicitly configured Linux HOME/PATH may replace the distro defaults.
    if (['HOME', 'PATH', 'USERPROFILE'].includes(key)) {
      return key !== 'USERPROFILE' && configured[key]?.startsWith('/') && !configured[key].includes('\\');
    }
    return key !== 'WSLENV';
  }).map(key => {
    const hostPath = PATH_KEYS.has(key) && /^(?:[a-zA-Z]:[\\/]|[\\/]{2})/u.test(env[key] ?? '');
    return { key, hostPath, pathList: hostPath && key === 'SSL_CERT_DIR' };
  });
}
