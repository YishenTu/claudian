import * as path from 'path';

import { getEnhancedPath } from '@/core/process/env';
import { getRuntimeEnvironmentVariables } from '@/core/providers/providerEnvironment';

import { getAntigravityProviderSettings } from '../settings';

export function getAntigravityRuntimeEnvironment(
  settings: Record<string, unknown>,
  cliPath?: string | null,
): NodeJS.ProcessEnv {
  const providerSettings = getAntigravityProviderSettings(settings);
  const providerEnv = getRuntimeEnvironmentVariables(settings, 'antigravity');

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...providerEnv,
  };

  if (providerSettings.geminiApiKey) {
    env.GEMINI_API_KEY = providerSettings.geminiApiKey;
  }

  const binaryDir = cliPath && path.isAbsolute(cliPath) ? path.dirname(cliPath) : undefined;
  env.PATH = getEnhancedPath(env.PATH, binaryDir);

  return env;
}
