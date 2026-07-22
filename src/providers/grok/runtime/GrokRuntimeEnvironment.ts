import { getRuntimeEnvironmentText } from '../../../core/providers/providerEnvironment';
import { getEnhancedPath, parseEnvironmentVariables } from '../../../utils/env';

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
