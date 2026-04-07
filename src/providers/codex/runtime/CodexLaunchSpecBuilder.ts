import {
  inferWslDistroFromWindowsPath,
  resolveCodexExecutionTarget,
} from './CodexExecutionTargetResolver';
import type { CodexLaunchSpec } from './codexLaunchTypes';
import { createCodexPathMapper } from './CodexPathMapper';

export interface BuildCodexLaunchSpecOptions {
  settings: Record<string, unknown>;
  resolvedCliCommand: string | null;
  hostVaultPath: string | null;
  env: Record<string, string>;
  hostPlatform?: NodeJS.Platform;
  resolveDefaultWslDistro?: () => string | undefined;
}

const CODEX_APP_SERVER_ARGS = Object.freeze(['app-server', '--listen', 'stdio://']);

export function buildCodexLaunchSpec(
  options: BuildCodexLaunchSpecOptions,
): CodexLaunchSpec {
  const target = resolveCodexExecutionTarget({
    settings: options.settings,
    hostPlatform: options.hostPlatform,
    hostVaultPath: options.hostVaultPath,
    resolveDefaultWslDistro: options.resolveDefaultWslDistro,
  });
  const pathMapper = createCodexPathMapper(target);
  const spawnCwd = options.hostVaultPath ?? process.cwd();

  const workspaceDistro = inferWslDistroFromWindowsPath(options.hostVaultPath);
  if (
    target.method === 'wsl'
    && target.distroName
    && workspaceDistro
    && target.distroName.toLowerCase() !== workspaceDistro.toLowerCase()
  ) {
    throw new Error(
      `WSL distro override "${target.distroName}" does not match workspace distro "${workspaceDistro}"`,
    );
  }

  if (target.method === 'wsl' && !target.distroName) {
    throw new Error(
      'Unable to determine the WSL distro. Set WSL distro override or configure a default WSL distro.',
    );
  }

  const targetCwd = pathMapper.toTargetPath(spawnCwd);

  if (!targetCwd) {
    throw new Error('WSL mode only supports Windows drive paths and \\\\wsl$ workspace paths');
  }

  const resolvedCliCommand = options.resolvedCliCommand?.trim() || 'codex';
  if (target.method === 'wsl') {
    const args = [
      ...(target.distroName ? ['--distribution', target.distroName] : []),
      '--cd',
      targetCwd,
      resolvedCliCommand,
      ...CODEX_APP_SERVER_ARGS,
    ];

    return {
      target,
      command: 'wsl.exe',
      args,
      spawnCwd,
      targetCwd,
      env: options.env,
      pathMapper,
    };
  }

  return {
    target,
    command: resolvedCliCommand,
    args: [...CODEX_APP_SERVER_ARGS],
    spawnCwd,
    targetCwd,
    env: options.env,
    pathMapper,
  };
}
