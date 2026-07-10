import { execFileSync } from 'child_process';

import { getCodexProviderSettings } from '../settings';
import type {
  CodexExecutionPlatformFamily,
  CodexExecutionPlatformOs,
  CodexExecutionTarget,
} from './codexLaunchTypes';

export interface ResolveCodexExecutionTargetOptions {
  settings: Record<string, unknown>;
  hostPlatform?: NodeJS.Platform;
  hostVaultPath?: string | null;
  resolveDefaultWslDistro?: () => string | undefined;
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

function looksLikeUtf16Le(output: Buffer): boolean {
  const sampleLength = Math.min(output.length - (output.length % 2), 512);
  if (sampleLength < 4) {
    return false;
  }

  let evenNullBytes = 0;
  let oddNullBytes = 0;
  for (let index = 0; index < sampleLength; index += 2) {
    if (output[index] === 0) {
      evenNullBytes += 1;
    }
    if (output[index + 1] === 0) {
      oddNullBytes += 1;
    }
  }

  const bytePairs = sampleLength / 2;
  return oddNullBytes / bytePairs >= 0.2 && oddNullBytes > evenNullBytes * 2;
}

function decodeWslListOutput(output: string | Buffer): string {
  if (typeof output === 'string') {
    return output;
  }

  const hasUtf16LeBom = output.length >= 2 && output[0] === 0xFF && output[1] === 0xFE;
  if (hasUtf16LeBom || looksLikeUtf16Le(output)) {
    return output.toString('utf16le');
  }

  return output.toString('utf8');
}

export function parseDefaultWslDistroListOutput(output: string | Buffer): string | undefined {
  const decodedOutput = decodeWslListOutput(output);
  for (const line of decodedOutput.replace(/\uFEFF/g, '').split(/\r?\n/)) {
    const trimmed = line.trimStart();
    if (!trimmed.startsWith('*')) {
      continue;
    }

    const candidate = trimmed.slice(1).trimStart().split(/\s{2,}/)[0]?.trim();
    if (candidate) {
      return candidate;
    }
  }

  return undefined;
}

function resolveDefaultWslDistroName(): string | undefined {
  try {
    const output = execFileSync('wsl.exe', ['--list', '--verbose'], {
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    });
    return parseDefaultWslDistroListOutput(output);
  } catch {
    return undefined;
  }
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
  if (codexSettings.installationMethod === 'wsl') {
    const distroName = codexSettings.wslDistroOverride
      || inferWslDistroFromWindowsPath(options.hostVaultPath)
      || options.resolveDefaultWslDistro?.()
      || resolveDefaultWslDistroName();

    return {
      method: 'wsl',
      platformFamily: 'unix',
      platformOs: 'linux',
      distroName,
    };
  }

  return {
    method: 'native-windows',
    platformFamily: 'windows',
    platformOs: 'windows',
  };
}
