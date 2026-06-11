import {
  getCodexProviderSettings,
  isCodexWslInstallationMethod,
} from '../settings';
import type {
  CodexExecutionPlatformFamily,
  CodexExecutionPlatformOs,
  CodexExecutionTarget,
} from './codexLaunchTypes';

export interface ResolveCodexExecutionTargetOptions {
  settings: Record<string, unknown>;
  hostPlatform?: NodeJS.Platform;
  hostVaultPath?: string | null;
}

function resolveHostPlatformOs(hostPlatform: NodeJS.Platform): CodexExecutionPlatformOs {
  if (hostPlatform === 'win32') {
    return 'windows';
  }

  if (hostPlatform === 'darwin') {
    return 'macos';
  }

  return 'linux';
}

function resolveHostPlatformFamily(hostPlatform: NodeJS.Platform): CodexExecutionPlatformFamily {
  return hostPlatform === 'win32' ? 'windows' : 'unix';
}

export function inferWslDistroFromWindowsPath(hostPath: string | null | undefined): string | undefined {
  if (!hostPath) {
    return undefined;
  }

  const normalized = hostPath.replace(/\//g, '\\');
  const match = normalized.match(/^\\\\wsl\$\\([^\\]+)(?:\\|$)/i);
  return match?.[1] || undefined;
}

export function resolveCodexExecutionTarget(
  options: ResolveCodexExecutionTargetOptions,
): CodexExecutionTarget {
  const hostPlatform = options.hostPlatform ?? process.platform;
  if (hostPlatform !== 'win32') {
    return {
      method: 'host-native',
      platformFamily: resolveHostPlatformFamily(hostPlatform),
      platformOs: resolveHostPlatformOs(hostPlatform),
    };
  }

  const codexSettings = getCodexProviderSettings(options.settings);
  if (isCodexWslInstallationMethod(codexSettings.installationMethod)) {
    return {
      method: 'wsl',
      platformFamily: 'unix',
      platformOs: 'linux',
      distroName: codexSettings.wslDistroOverride || undefined,
      wslVersion: codexSettings.installationMethod === 'wsl1' ? 1 : 2,
    };
  }

  if (codexSettings.installationMethod === 'wsl-unconfigured') {
    throw new Error('Legacy WSL configuration detected. Select WSL 1 or WSL 2 in Codex settings.');
  }

  return {
    method: 'native-windows',
    platformFamily: 'windows',
    platformOs: 'windows',
  };
}
