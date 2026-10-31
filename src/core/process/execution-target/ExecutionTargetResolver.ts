import { execFile, execFileSync } from 'child_process';
import { promisify } from 'util';

import type {
  ExecutionPlatformFamily,
  ExecutionPlatformOs,
  ExecutionTarget,
} from '@/core/process/execution-target/types';
import { getWSLExecutable } from '@/core/process/execution-target/WSLExecutable';
import type { InstallationSettings } from '@/core/providers/settings/InstallationSettings';

export type ExecutionTargetSettings = InstallationSettings;

export interface ResolveExecutionTargetOptions {
  settings: ExecutionTargetSettings;
  hostPlatform?: NodeJS.Platform;
  hostVaultPath?: string | null;
  resolveDefaultWSLDistro?: () => string | undefined;
}

function resolveHostPlatformOs(hostPlatform: NodeJS.Platform): ExecutionPlatformOs {
  if (hostPlatform === 'win32') {
    return 'windows';
  }

  if (hostPlatform === 'darwin') {
    return 'macos';
  }

  return 'linux';
}

function resolveHostPlatformFamily(hostPlatform: NodeJS.Platform): ExecutionPlatformFamily {
  return hostPlatform === 'win32' ? 'windows' : 'unix';
}

export function inferWSLDistroFromWindowsPath(hostPath: string | null | undefined): string | undefined {
  if (!hostPath) {
    return undefined;
  }

  const normalized = hostPath.replace(/\//g, '\\');
  const match = normalized.match(/^\\\\(?:wsl\$|wsl\.localhost)\\([^\\]+)(?:\\|$)/i);
  return match?.[1] || undefined;
}

function looksLikeUTF16LE(output: Buffer): boolean {
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

function decodeWSLListOutput(output: string | Buffer): string {
  if (typeof output === 'string') {
    return output;
  }

  const hasUTF16LEBom = output.length >= 2 && output[0] === 0xFF && output[1] === 0xFE;
  if (hasUTF16LEBom || looksLikeUTF16LE(output)) {
    return output.toString('utf16le');
  }

  return output.toString('utf8');
}

export function parseDefaultWSLDistroListOutput(output: string | Buffer): string | undefined {
  const decodedOutput = decodeWSLListOutput(output);
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

const execFileAsync = promisify(execFile);

function resolveDefaultWSLDistroName(): string | undefined {
  try {
    const output = execFileSync(getWSLExecutable(), ['--list', '--verbose'], {
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5_000,
      windowsHide: true,
    });
    return parseDefaultWSLDistroListOutput(output);
  } catch {
    return undefined;
  }
}

async function resolveDefaultWSLDistroNameAsync(): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync(getWSLExecutable(), ['--list', '--verbose'], {
      encoding: null,
      timeout: 5_000,
      windowsHide: true,
    });
    return parseDefaultWSLDistroListOutput(stdout);
  } catch {
    return undefined;
  }
}

export function resolveExecutionTarget(
  options: ResolveExecutionTargetOptions,
): ExecutionTarget {
  const hostPlatform = options.hostPlatform ?? process.platform;
  if (hostPlatform !== 'win32') {
    return {
      method: 'host-native',
      platformFamily: resolveHostPlatformFamily(hostPlatform),
      platformOs: resolveHostPlatformOs(hostPlatform),
    };
  }

  const { settings } = options;
  if (settings.installationMethod === 'wsl') {
    const distroName = settings.wslDistroOverride
      || inferWSLDistroFromWindowsPath(options.hostVaultPath)
      || options.resolveDefaultWSLDistro?.()
      || resolveDefaultWSLDistroName();

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

export async function resolveExecutionTargetAsync(
  options: ResolveExecutionTargetOptions,
): Promise<ExecutionTarget> {
  const hostPlatform = options.hostPlatform ?? process.platform;
  if (hostPlatform !== 'win32') {
    return {
      method: 'host-native',
      platformFamily: resolveHostPlatformFamily(hostPlatform),
      platformOs: resolveHostPlatformOs(hostPlatform),
    };
  }

  const { settings } = options;
  if (settings.installationMethod === 'wsl') {
    const distroName = settings.wslDistroOverride
      || inferWSLDistroFromWindowsPath(options.hostVaultPath)
      || (options.resolveDefaultWSLDistro
        ? await Promise.resolve(options.resolveDefaultWSLDistro())
        : undefined)
      || await resolveDefaultWSLDistroNameAsync();

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
