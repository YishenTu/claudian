import type ClaudianPlugin from '../../../main';
import { getEnhancedPath, parseEnvironmentVariables } from '../../../utils/env';

export function buildCursorAgentEnvironment(plugin: ClaudianPlugin): Record<string, string> {
  const customEnv = parseEnvironmentVariables(plugin.getActiveEnvironmentVariables('cursor'));
  const baseEnv = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
  const enhancedPath = getEnhancedPath(customEnv.PATH);

  return {
    ...baseEnv,
    ...customEnv,
    PATH: enhancedPath,
  };
}
