import { getEnhancedPath, parseEnvironmentVariables } from '@/core/process/env';

import { getRuntimeEnvironmentText } from '../../../core/providers/providerEnvironment';

export function buildGrokRuntimeEnv(
  settings: Record<string, unknown>,
  cliPath: string,
): NodeJS.ProcessEnv {
  const environmentText = getRuntimeEnvironmentText(settings, 'grok');
  const configuredEnvironment = parseEnvironmentVariables(environmentText);

  return {
    ...process.env,
    ...configuredEnvironment,
    PATH: getEnhancedPath(configuredEnvironment.PATH, cliPath || undefined),
  };
}
