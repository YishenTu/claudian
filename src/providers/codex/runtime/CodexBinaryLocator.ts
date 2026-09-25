import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { findCLIBinaryPath, resolveConfiguredCLIPath } from '../../../utils/cliBinaryLocator';
import { parseEnvironmentVariables } from '../../../utils/env';
import { expandHomePath, stripSurroundingQuotes } from '../../../utils/path';
import type { CodexInstallationMethod } from '../settings';
import type { CodexExecutionTarget } from './codexLaunchTypes';

export function isWindowsStyleCLIReference(value: string | null | undefined): boolean {
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

  return findCLIBinaryPath('codex', additionalPath, platform);
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
      path.join(home, 'Applications', 'ChatGPT.app', 'Contents', 'Resources'),
      '/Applications/ChatGPT.app/Contents/Resources',
    ];
  }

  if (platform !== 'win32') {
    return [
      path.join(home, '.local', 'bin'),
    ];
  }

  return getPreferredWindowsCodexBinaryDirs();
}

function getPreferredWindowsCodexBinaryDirs(): string[] {
  const preferredDirs: string[] = [];
  const configuredInstallDir = process.env.CODEX_INSTALL_DIR?.trim();
  if (configuredInstallDir) {
    preferredDirs.push(expandHomePath(stripSurroundingQuotes(configuredInstallDir)));
  }

  const localAppData = process.env.LOCALAPPDATA;
  if (localAppData) {
    preferredDirs.push(path.join(localAppData, 'Programs', 'OpenAI', 'Codex', 'bin'));
    preferredDirs.push(...getCompleteCodexDesktopRuntimeDirs(
      path.join(localAppData, 'OpenAI', 'Codex', 'bin'),
    ));
  }

  return [...new Set(preferredDirs)].filter(isCompleteWindowsCodexRuntimeDir);
}

function getCompleteCodexDesktopRuntimeDirs(runtimeRoot: string): string[] {
  try {
    return fs.readdirSync(runtimeRoot, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => path.join(runtimeRoot, entry.name))
      .filter(isCompleteWindowsCodexRuntimeDir)
      // Executable timestamps are a freshness heuristic, not an app-owned active-version marker.
      .map(dir => ({ dir, mtime: getCodexBinaryMtime(dir) }))
      .sort((left, right) => right.mtime - left.mtime
        || (left.dir < right.dir ? -1 : left.dir > right.dir ? 1 : 0))
      .map(candidate => candidate.dir);
  } catch {
    return [];
  }
}

function isCompleteWindowsCodexRuntimeDir(dir: string): boolean {
  return isExistingFile(path.join(dir, 'codex.exe'))
    && isExistingFile(path.join(dir, 'codex-code-mode-host.exe'));
}

function getCodexBinaryMtime(dir: string): number {
  try {
    return fs.statSync(path.join(dir, 'codex.exe')).mtimeMs;
  } catch {
    return 0;
  }
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

export function resolveCodexCLIPath(
  hostnamePath: string | undefined,
  legacyPath: string | undefined,
  envText: string,
  options: {
    executionTarget?: CodexExecutionTarget;
    installationMethod?: CodexInstallationMethod;
    hostPlatform?: NodeJS.Platform;
  } = {},
): string | null {
  const hostPlatform = options.hostPlatform ?? process.platform;
  const isWslTarget = options.executionTarget
    ? options.executionTarget.method === 'wsl'
    : hostPlatform === 'win32' && options.installationMethod === 'wsl';

  if (isWslTarget) {
    const configuredCommand = [hostnamePath, legacyPath]
      .map(value => stripSurroundingQuotes((value ?? '').trim()))
      .find(value => value.length > 0 && !isWindowsStyleCLIReference(value));
    return configuredCommand || 'codex';
  }

  const configuredHostnamePath = resolveConfiguredCLIPath(hostnamePath);
  if (configuredHostnamePath) {
    return configuredHostnamePath;
  }

  const configuredLegacyPath = resolveConfiguredCLIPath(legacyPath);
  if (configuredLegacyPath) {
    return configuredLegacyPath;
  }

  const customEnv = parseEnvironmentVariables(envText || '');
  return findCodexBinaryPath(customEnv.PATH, hostPlatform);
}
