import { execFileSync } from 'child_process';
import * as path from 'path';

import { listWslDistributionsSync } from '../../../utils/wslDistributions';
import {
  createWslPathMapper,
  inferWslDistroFromWindowsPath,
  type WslPathMapper,
} from '../../../utils/wslPathMapper';
import {
  getClaudeProviderSettings,
  isClaudeWslInstallationMethod,
} from '../settings';

export interface ClaudeExecutionContext {
  method: 'host-native' | 'native-windows' | 'wsl';
  hostVaultPath: string;
  targetVaultPath: string;
  cliCommand: string;
  distroName?: string;
  wslVersion?: 1 | 2;
  wslHomeTarget?: string;
  claudeHomeHost?: string;
  pathMapper?: WslPathMapper;
  toTargetPath(hostPath: string): string | null;
  toHostPath(targetPath: string): string | null;
}

function resolveWslHome(distroName: string): string {
  const output = execFileSync(
    'wsl.exe',
    ['--distribution', distroName, '--exec', 'sh', '-lc', 'printf %s "$HOME"'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true },
  ).trim();
  if (!output.startsWith('/')) {
    throw new Error(`Could not resolve HOME for WSL distro "${distroName}"`);
  }
  return path.posix.normalize(output);
}

export function resolveClaudeExecutionContext(options: {
  settings: Record<string, unknown>;
  hostVaultPath: string;
  resolvedCliPath: string | null;
  hostPlatform?: NodeJS.Platform;
  resolveWslHome?: (distroName: string) => string;
  resolveWslDistroVersion?: (distroName: string) => 1 | 2 | undefined;
}): ClaudeExecutionContext {
  const hostPlatform = options.hostPlatform ?? process.platform;
  const claudeSettings = getClaudeProviderSettings(options.settings);
  if (hostPlatform !== 'win32') {
    const vaultPath = path.resolve(options.hostVaultPath);
    return {
      method: 'host-native',
      hostVaultPath: vaultPath,
      targetVaultPath: vaultPath,
      cliCommand: options.resolvedCliPath ?? 'claude',
      toTargetPath: value => path.resolve(value),
      toHostPath: value => path.resolve(value),
    };
  }

  if (!isClaudeWslInstallationMethod(claudeSettings.installationMethod)) {
    return {
      method: 'native-windows',
      hostVaultPath: options.hostVaultPath,
      targetVaultPath: path.win32.normalize(options.hostVaultPath),
      cliCommand: options.resolvedCliPath ?? 'claude.exe',
      toTargetPath: value => path.win32.normalize(value),
      toHostPath: value => path.win32.normalize(value),
    };
  }

  const distroName = claudeSettings.wslDistroOverride;
  if (!distroName) throw new Error('Select a WSL distro in Claude settings before starting Claude.');
  const workspaceDistro = inferWslDistroFromWindowsPath(options.hostVaultPath);
  if (workspaceDistro && workspaceDistro.toLowerCase() !== distroName.toLowerCase()) {
    throw new Error(
      `WSL distro override "${distroName}" does not match workspace distro "${workspaceDistro}"`,
    );
  }

  const expectedVersion = claudeSettings.installationMethod === 'wsl1' ? 1 : 2;
  const installedVersion = options.resolveWslDistroVersion?.(distroName)
    ?? listWslDistributionsSync()
      .find(distro => distro.name.toLowerCase() === distroName.toLowerCase())
      ?.version;
  if (!installedVersion) throw new Error(`WSL distro "${distroName}" is not installed`);
  if (installedVersion !== expectedVersion) {
    throw new Error(
      `WSL distro "${distroName}" uses WSL ${installedVersion}, but WSL ${expectedVersion} is selected`,
    );
  }

  const mapper = createWslPathMapper(distroName);
  const targetVaultPath = mapper.toWslPath(options.hostVaultPath);
  if (!targetVaultPath) {
    throw new Error('Claude WSL mode only supports Windows drive paths and matching \\\\wsl$ paths');
  }
  const wslHomeTarget = (options.resolveWslHome ?? resolveWslHome)(distroName);
  const claudeHomeHost = mapper.toHostPath(path.posix.join(wslHomeTarget, '.claude'));
  if (!claudeHomeHost) throw new Error(`Could not map Claude home for WSL distro "${distroName}"`);

  return {
    method: 'wsl',
    hostVaultPath: options.hostVaultPath,
    targetVaultPath,
    cliCommand: options.resolvedCliPath?.trim() || 'claude',
    distroName,
    wslVersion: expectedVersion,
    wslHomeTarget,
    claudeHomeHost,
    pathMapper: mapper,
    toTargetPath: value => mapper.toWslPath(value),
    toHostPath: value => mapper.toHostPath(value),
  };
}
