import { getRuntimeEnvironmentText } from '../../../core/providers/providerEnvironment';
import { getEnhancedPath, parseEnvironmentVariables } from '../../../utils/env';

export function buildCodeBuddyRuntimeEnv(
  settings: Record<string, unknown>,
  cliPath: string,
): NodeJS.ProcessEnv {
  const customEnv = parseEnvironmentVariables(getRuntimeEnvironmentText(settings, 'codebuddy'));
  return {
    ...process.env,
    ...customEnv,
    PATH: getEnhancedPath(customEnv.PATH, cliPath),
  };
}
