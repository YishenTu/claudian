import { getEnhancedPath, parseEnvironmentVariables } from '@/core/process/env';

import { getRuntimeEnvironmentText } from '../../../core/providers/providerEnvironment';

export function buildGrokRuntimeEnv(
  settings: Record<string, unknown>,
  cliPath: string,
): NodeJS.ProcessEnv {
  const environmentText = getRuntimeEnvironmentText(settings, 'grok');
  const configuredEnvironment = parseEnvironmentVariables(environmentText);

  return {
    // Embedded vaults need native project discovery without a terminal trust prompt.
    // Explicit process or configured environment values retain precedence.
    GROK_FOLDER_TRUST: '0',
    ...process.env,
    ...configuredEnvironment,
    PATH: getEnhancedPath(configuredEnvironment.PATH, cliPath || undefined),
  };
}
