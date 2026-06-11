import {
  inferWslDistroFromWindowsPath,
  resolveCodexExecutionTarget,
} from './CodexExecutionTargetResolver';
import type { CodexLaunchSpec } from './codexLaunchTypes';
import { createCodexPathMapper } from './CodexPathMapper';
import { listCodexWslDistributionsSync } from './CodexWslDistributionService';

export interface BuildCodexLaunchSpecOptions {
  settings: Record<string, unknown>;
  resolvedCliCommand: string | null;
  hostVaultPath: string | null;
  env: Record<string, string>;
  hostPlatform?: NodeJS.Platform;
  resolveWslDistroVersion?: (distroName: string) => 1 | 2 | undefined;
}

const CODEX_APP_SERVER_ARGS = Object.freeze(['app-server', '--listen', 'stdio://']);
const WSL_LOGIN_SHELL_COMMAND = 'exec "$SHELL" -lic "$1"';

function quotePosixShellArgument(value: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) {
    return value;
  }
  return `'${value.replace(/'/g, "'\"'\"'")}'`;
}

export function buildCodexLaunchSpec(
  options: BuildCodexLaunchSpecOptions,
): CodexLaunchSpec {
  const target = resolveCodexExecutionTarget({
    settings: options.settings,
    hostPlatform: options.hostPlatform,
    hostVaultPath: options.hostVaultPath,
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
      'Select a WSL distro in Codex settings before starting Codex.',
    );
  }

  if (target.method === 'wsl' && target.distroName && target.wslVersion) {
    const installedVersion = options.resolveWslDistroVersion?.(target.distroName)
      ?? listCodexWslDistributionsSync()
        .find(distro => distro.name.toLowerCase() === target.distroName!.toLowerCase())
        ?.version;
    if (!installedVersion) {
      throw new Error(`WSL distro "${target.distroName}" is not installed`);
    }
    if (installedVersion !== target.wslVersion) {
      throw new Error(
        `WSL distro "${target.distroName}" uses WSL ${installedVersion}, but WSL ${target.wslVersion} is selected`,
      );
    }
  }

  const targetCwd = pathMapper.toTargetPath(spawnCwd);

  if (!targetCwd) {
    throw new Error('WSL mode only supports Windows drive paths and \\\\wsl$ workspace paths');
  }

  const resolvedCliCommand = options.resolvedCliCommand?.trim() || 'codex';
  if (target.method === 'wsl') {
    const appServerCommand = [
      'exec',
      quotePosixShellArgument(resolvedCliCommand),
      ...CODEX_APP_SERVER_ARGS.map(quotePosixShellArgument),
    ].join(' ');
    const args = [
      ...(target.distroName ? ['--distribution', target.distroName] : []),
      '--cd',
      targetCwd,
      '--exec',
      'sh',
      '-lc',
      WSL_LOGIN_SHELL_COMMAND,
      'sh',
      appServerCommand,
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
