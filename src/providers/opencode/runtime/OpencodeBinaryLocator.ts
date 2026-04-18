import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { getEnhancedPath, parseEnvironmentVariables } from '../../../utils/env';
import { expandHomePath, parsePathEntries } from '../../../utils/path';

function isExistingFile(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function resolveConfiguredPath(configuredPath: string | undefined): string | null {
  const trimmed = (configuredPath ?? '').trim();
  if (!trimmed) {
    return null;
  }

  try {
    const expandedPath = expandHomePath(trimmed);
    return isExistingFile(expandedPath) ? expandedPath : null;
  } catch {
    return null;
  }
}

function getOpencodeHomePaths(): string[] {
  const home = os.homedir();
  const paths: string[] = [];

  if (process.platform === 'darwin') {
    paths.push(path.join(home, '.opencode', 'bin'));
  }

  if (process.platform === 'linux') {
    paths.push(path.join(home, '.opencode', 'bin'));
  }

  if (process.platform === 'win32') {
    paths.push(path.join(home, 'AppData', 'Local', 'opencode', 'bin'));
    paths.push(path.join(home, '.opencode', 'bin'));
  }

  return paths;
}

export function findOpencodeBinaryPath(
  additionalPath?: string,
  platform: NodeJS.Platform = process.platform,
): string | null {
  const binaryNames = platform === 'win32'
    ? ['opencode.exe', 'opencode.cmd', 'opencode']
    : ['opencode'];

  const searchEntries = parsePathEntries(getEnhancedPath(additionalPath));
  const opencodeHomePaths = getOpencodeHomePaths();
  const allPaths = [...opencodeHomePaths, ...searchEntries];

  for (const dir of allPaths) {
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

export function resolveOpencodeCliPath(
  configuredPath: string | undefined,
  envText: string,
  options: { hostPlatform?: NodeJS.Platform } = {},
): string | null {
  const hostPlatform = options.hostPlatform ?? process.platform;

  const configured = resolveConfiguredPath(configuredPath);
  if (configured) {
    return configured;
  }

  const customEnv = parseEnvironmentVariables(envText || '');
  return findOpencodeBinaryPath(customEnv.PATH, hostPlatform);
}