import { getCodexProviderSettings } from '../settings';
import {
  inferWslDistroFromWindowsPath,
  resolveCodexExecutionTarget,
} from './CodexExecutionTargetResolver';
import type { CodexExecutionTarget, CodexLaunchSpec } from './codexLaunchTypes';
import { createCodexPathMapper } from './CodexPathMapper';

export interface BuildCodexLaunchSpecOptions {
  settings: Record<string, unknown>;
  resolvedCliCommand: string | null;
  cliArgs?: readonly string[];
  hostVaultPath: string | null;
  env: Record<string, string>;
  executionTarget?: CodexExecutionTarget;
  hostPlatform?: NodeJS.Platform;
  resolveDefaultWslDistro?: () => string | undefined;
}

const CODEX_APP_SERVER_ARGS = Object.freeze(['app-server', '--listen', 'stdio://']);

export function buildCodexLaunchSpec(
  options: BuildCodexLaunchSpecOptions,
): CodexLaunchSpec {
  const target = options.executionTarget ?? resolveCodexExecutionTarget({
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
  const verbosity = getCodexProviderSettings(options.settings).responseVerbosity;
  // Verbosity has no turn/start override. Launch args participate in the runtime
  // fingerprint, so changing this setting replaces the server for subsequent work.
  const cliArgs = options.cliArgs ?? [
    ...CODEX_APP_SERVER_ARGS,
    ...(verbosity === 'default' ? [] : ['-c', `model_verbosity="${verbosity}"`]),
  ];
  if (target.method === 'wsl') {
    const args = [
      ...(target.distroName ? ['--distribution', target.distroName] : []),
      '--cd',
      targetCwd,
      resolvedCliCommand,
      ...cliArgs,
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
    args: [...cliArgs],
    spawnCwd,
    targetCwd,
    env: options.env,
    pathMapper,
  };
}
