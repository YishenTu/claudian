import * as os from 'os';
import * as path from 'path';

import { getRuntimeEnvironmentText } from '../../../core/providers/providerEnvironment';
import { getEnhancedPath, parseEnvironmentVariables } from '../../../utils/env';
import { getGrokHome } from '../history/GrokHistoryPaths';
import { getGrokProviderSettings } from '../settings';

/**
 * Build the environment for Grok Build subprocesses.
 *
 * - Disables telemetry trace upload by default unless the user explicitly sets
 *   GROK_TELEMETRY_TRACE_UPLOAD.
 * - Maps Claudian safeMode to GROK_SANDBOX when the user did not set GROK_SANDBOX.
 *   `grok agent stdio` has no `--sandbox` flag; Grok reads this env (best-effort).
 */
export function buildGrokRuntimeEnv(
  settings: Record<string, unknown>,
  cliPath: string,
): NodeJS.ProcessEnv {
  const envText = getRuntimeEnvironmentText(settings, 'grok');
  const customEnv = parseEnvironmentVariables(envText);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...customEnv,
  };

  const pathEntries = [
    path.dirname(cliPath),
    path.join(os.homedir(), '.grok', 'bin'),
    env.PATH,
  ].filter(Boolean);
  env.PATH = getEnhancedPath(pathEntries.join(path.delimiter), cliPath || undefined);
  env.TERM = env.TERM || 'xterm-256color';
  env.COLORTERM = env.COLORTERM || 'truecolor';

  if (env.GROK_TELEMETRY_TRACE_UPLOAD === undefined) {
    env.GROK_TELEMETRY_TRACE_UPLOAD = '0';
  }

  if (env.GROK_SANDBOX === undefined) {
    env.GROK_SANDBOX = getGrokProviderSettings(settings).safeMode;
  }

  return env;
}

/** Resolve the Grok home directory effective for a Claudian settings bag. */
export function resolveGrokHomeFromSettings(
  settings: Record<string, unknown>,
  cliPath = '',
): string {
  return getGrokHome(buildGrokRuntimeEnv(settings, cliPath));
}
