import * as os from 'os';
import * as path from 'path';

export interface ClaudeConfigDirContext {
  environment?: NodeJS.ProcessEnv;
  hostPlatform?: NodeJS.Platform;
  vaultPath?: string | null;
}

function resolveSdkHomeDir(
  environment: NodeJS.ProcessEnv,
  hostPlatform: NodeJS.Platform,
): string {
  if (hostPlatform === 'win32') {
    if (environment.USERPROFILE !== undefined) {
      return environment.USERPROFILE;
    }
    if (environment.HOMEDRIVE !== undefined && environment.HOMEPATH !== undefined) {
      return `${environment.HOMEDRIVE}${environment.HOMEPATH}`;
    }
  } else if (environment.HOME !== undefined) {
    return environment.HOME;
  }

  return os.homedir();
}

function resolveFromSdkWorkingDirectory(
  value: string,
  vaultPath?: string | null,
): string {
  const normalizedValue = value.normalize('NFC');
  return path.isAbsolute(normalizedValue)
    ? path.normalize(normalizedValue)
    : path.resolve(vaultPath ?? process.cwd(), normalizedValue);
}

export function resolveClaudeConfigDir(context?: ClaudeConfigDirContext): string {
  const environment = context?.environment ?? process.env;
  const configuredDir = environment.CLAUDE_CONFIG_DIR;
  if (configuredDir === undefined) {
    const homeDir = context?.environment
      ? resolveSdkHomeDir(environment, context.hostPlatform ?? process.platform)
      : os.homedir();
    return resolveFromSdkWorkingDirectory(
      path.join(homeDir, '.claude'),
      context?.vaultPath,
    );
  }

  return resolveFromSdkWorkingDirectory(configuredDir, context?.vaultPath);
}
