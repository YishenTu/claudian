import * as os from 'os';
import * as path from 'path';

import { resolveExecutionTarget } from '@/core/process/execution-target/ExecutionTargetResolver';
import type { ExecutionTarget } from '@/core/process/execution-target/types';
import { createExecutionPathMapper } from '@/core/process/execution-target/WSLPathMapper';

import { decodeClaudeConfig } from '../config';

export interface ClaudeConfigDirContext {
  config?: Readonly<Record<string, unknown>>;
  environmentText?: string;
  executionTarget?: ExecutionTarget;
  /** Set only after querying the target shell with the same launch environment. */
  targetEnvironmentResolved?: boolean;
  environment?: NodeJS.ProcessEnv;
  hostPlatform?: NodeJS.Platform;
  vaultPath?: string | null;
}

function resolveSDKHomeDir(
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

function resolveFromSDKWorkingDirectory(
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
  const target = getClaudeExecutionTarget(context);
  if (target?.method === 'wsl') {
    const mapper = createExecutionPathMapper(target);
    const configured = environment.CLAUDE_CONFIG_DIR;
    let directory: string;
    if (configured !== undefined) {
      if (/^(?:[a-zA-Z]:|[\\/]{2})/u.test(configured)) {
        const mapped = mapper.toTargetPath(configured);
        if (!mapped) throw new Error('Claude config directory is outside the selected WSL distro');
        directory = mapped;
      } else {
        const cwd = context?.vaultPath && mapper.toTargetPath(context.vaultPath);
        if (!path.posix.isAbsolute(configured) && !cwd) throw new Error('Claude config directory requires a Linux working directory');
        directory = path.posix.resolve(cwd || '/', configured.normalize('NFC'));
      }
    } else {
      if (!environment.HOME?.startsWith('/')) throw new Error('Unable to resolve Claude Code Linux HOME');
      directory = path.posix.join(environment.HOME, '.claude');
    }
    const hostDirectory = mapper.toHostPath(directory);
    if (!hostDirectory) throw new Error('Unable to map Claude Code config directory to the host');
    return hostDirectory;
  }
  const configuredDir = environment.CLAUDE_CONFIG_DIR;
  if (configuredDir === undefined) {
    const homeDir = context?.environment
      ? resolveSDKHomeDir(environment, context.hostPlatform ?? process.platform)
      : os.homedir();
    return resolveFromSDKWorkingDirectory(
      path.join(homeDir, '.claude'),
      context?.vaultPath,
    );
  }

  return resolveFromSDKWorkingDirectory(configuredDir, context?.vaultPath);
}

export function getClaudeExecutionTarget(context?: ClaudeConfigDirContext): ExecutionTarget | undefined {
  return context?.executionTarget ?? (context?.config ? resolveExecutionTarget({
    settings: decodeClaudeConfig(context.config), hostPlatform: context.hostPlatform, hostVaultPath: context.vaultPath,
  }) : undefined);
}

export function getClaudeHostPathModule(context?: ClaudeConfigDirContext): typeof path {
  return getClaudeExecutionTarget(context)?.method === 'wsl' ? path.win32 : path;
}
