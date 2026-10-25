import { getEnhancedPath, parseEnvironmentVariables } from '@/core/process/env';

/** Builds a launch environment from the shared plus OpenCode-scoped environment text. */
export function buildOpencodeRuntimeEnv(
  environmentText: string,
  cliPath: string,
  databasePathOverride?: string | null,
  inheritedEnvironment: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const envVars = parseEnvironmentVariables(environmentText);
  return {
    ...process.env,
    ...inheritedEnvironment,
    ...envVars,
    OPENCODE_DISABLE_CLAUDE_CODE_PROMPT: 'true',
    ...(databasePathOverride ? { OPENCODE_DB: databasePathOverride } : {}),
    PATH: getEnhancedPath(envVars.PATH ?? (inheritedEnvironment.PATH !== process.env.PATH ? inheritedEnvironment.PATH : undefined), cliPath || undefined),
  };
}
