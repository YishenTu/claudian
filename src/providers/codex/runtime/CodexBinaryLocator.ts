import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { findCliBinaryPath, resolveConfiguredCliPath } from '../../../utils/cliBinaryLocator';
import { parseEnvironmentVariables } from '../../../utils/env';
import { expandHomePath } from '../../../utils/path';
import type { CodexInstallationMethod } from '../settings';

export function isWindowsStyleCliReference(value: string | null | undefined): boolean {
  const trimmed = (value ?? '').trim();
  if (!trimmed) {
    return false;
  }

  return /^[A-Za-z]:[\\/]/.test(trimmed)
    || trimmed.startsWith('\\\\')
    || /\.(?:exe|cmd|bat|ps1)$/i.test(trimmed);
}

export function findCodexBinaryPath(
  additionalPath?: string,
  platform: NodeJS.Platform = process.platform,
): string | null {
  const explicitPathBinary = findCodexBinaryInDirs(
    parsePathEntriesForPlatform(additionalPath, platform),
    platform,
  );
  if (explicitPathBinary) {
    return explicitPathBinary;
  }

  const preferredBinary = findCodexBinaryInDirs(
    getPreferredCodexBinaryDirs(platform),
    platform,
  );
  if (preferredBinary) {
    return preferredBinary;
  }

  return findCliBinaryPath('codex', additionalPath, platform);
}

function getCodexBinaryNames(platform: NodeJS.Platform): string[] {
  return platform === 'win32'
    ? ['codex.exe', 'codex.cmd', 'codex']
    : ['codex'];
}

function findCodexBinaryInDirs(dirs: string[], platform: NodeJS.Platform): string | null {
  const binaryNames = getCodexBinaryNames(platform);

  for (const dir of dirs) {
    if (!dir) continue;

    for (const binaryName of binaryNames) {
      const candidate = path.join(dir, binaryName);
      if (isExistingFile(candidate)) {
        return candidate;
      }
    }
  }

  return null;
}

function getPreferredCodexBinaryDirs(platform: NodeJS.Platform): string[] {
  const home = getHomeDir();

  if (platform === 'darwin') {
    return [
      path.join(home, 'Applications', 'Codex.app', 'Contents', 'Resources'),
      '/Applications/Codex.app/Contents/Resources',
      path.join(home, 'Applications', 'Codex.app', 'Contents', 'MacOS'),
      '/Applications/Codex.app/Contents/MacOS',
      path.join(home, '.local', 'bin'),
    ];
  }

  if (platform !== 'win32') {
    return [
      path.join(home, '.local', 'bin'),
    ];
  }

  return [];
}

function getHomeDir(): string {
  return process.env.HOME || process.env.USERPROFILE || os.homedir();
}

function isExistingFile(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function parsePathEntriesForPlatform(pathValue: string | undefined, platform: NodeJS.Platform): string[] {
  if (!pathValue) {
    return [];
  }

  const delimiter = platform === 'win32' ? ';' : ':';
  return pathValue
    .split(delimiter)
    .map(segment => stripSurroundingQuotes(segment.trim()))
    .filter(segment => {
      if (!segment) return false;
      const upper = segment.toUpperCase();
      return upper !== '$PATH' && upper !== '${PATH}' && upper !== '%PATH%';
    })
    .map(segment => expandHomePath(segment));
}

function stripSurroundingQuotes(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

export function resolveCodexCliPath(
  hostnamePath: string | undefined,
  legacyPath: string | undefined,
  envText: string,
  options: { installationMethod?: CodexInstallationMethod; hostPlatform?: NodeJS.Platform } = {},
): string | null {
  const hostPlatform = options.hostPlatform ?? process.platform;
  if (hostPlatform === 'win32' && options.installationMethod === 'wsl') {
    const configuredCommand = [hostnamePath, legacyPath]
      .map(value => (value ?? '').trim())
      .find(value => value.length > 0 && !isWindowsStyleCliReference(value));
    return configuredCommand || 'codex';
  }

  const configuredHostnamePath = resolveConfiguredCliPath(hostnamePath);
  if (configuredHostnamePath) {
    return configuredHostnamePath;
  }

  const configuredLegacyPath = resolveConfiguredCliPath(legacyPath);
  if (configuredLegacyPath) {
    return configuredLegacyPath;
  }

  const customEnv = parseEnvironmentVariables(envText || '');
  return findCodexBinaryPath(customEnv.PATH, hostPlatform);
}
