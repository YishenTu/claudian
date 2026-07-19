import * as os from 'os';
import * as path from 'path';

import { getRuntimeEnvironmentText } from '../../../core/providers/providerEnvironment';
import { getEnhancedPath, parseEnvironmentVariables } from '../../../utils/env';
import { getKimiCodeHome } from '../history/KimiHistoryPaths';

/**
 * Build the environment for Kimi Code ACP / auxiliary subprocesses.
 *
 * Supports KIMI_CODE_HOME and other Kimi-owned env vars from provider settings.
 * Never reads or writes credentials files.
 */
export function buildKimiRuntimeEnv(
  settings: Record<string, unknown>,
  cliPath: string,
): NodeJS.ProcessEnv {
  const envText = getRuntimeEnvironmentText(settings, 'kimi');
  const customEnv = parseEnvironmentVariables(envText);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...customEnv,
  };

  const pathEntries = [
    path.dirname(cliPath),
    path.join(os.homedir(), '.kimi-code', 'bin'),
    path.join(os.homedir(), '.local', 'bin'),
    env.PATH,
  ].filter(Boolean);
  env.PATH = getEnhancedPath(pathEntries.join(path.delimiter), cliPath || undefined);
  env.TERM = env.TERM || 'xterm-256color';
  env.COLORTERM = env.COLORTERM || 'truecolor';

  return env;
}

/** Resolve the Kimi home directory effective for a Claudian settings bag. */
export function resolveKimiCodeHomeFromSettings(
  settings: Record<string, unknown>,
  cliPath = '',
): string {
  return getKimiCodeHome(buildKimiRuntimeEnv(settings, cliPath));
}
