import * as fs from 'fs';
import * as path from 'path';

import { getEnhancedPath } from './env';
import { expandHomePath, parsePathEntries } from './path';

export function isExistingFile(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

export function resolveConfiguredCliPath(configuredPath: string | undefined): string | null {
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

export function findCliBinaryPath(
  binaryName: string,
  additionalPath?: string,
  platform: NodeJS.Platform = process.platform,
): string | null {
  const binaryNames = platform === 'win32'
    ? [`${binaryName}.exe`, `${binaryName}.cmd`, binaryName]
    : [binaryName];
  const searchEntries = platform === process.platform
    ? parsePathEntries(getEnhancedPath(additionalPath))
    : parsePathEntriesForPlatform(additionalPath, platform);

  for (const dir of searchEntries) {
    if (!dir) continue;

    for (const candidateName of binaryNames) {
      const candidate = path.join(dir, candidateName);
      if (isExistingFile(candidate)) {
        return candidate;
      }
    }
  }

  return null;
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
    .map(segment => translateMsysPathForPlatform(expandHomePath(segment), platform));
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

function translateMsysPathForPlatform(value: string, platform: NodeJS.Platform): string {
  if (platform !== 'win32') {
    return value;
  }

  const msysMatch = value.match(/^\/([a-zA-Z])(?:\/(.*))?$/);
  if (!msysMatch) {
    return value;
  }

  const driveLetter = msysMatch[1].toUpperCase();
  const restOfPath = msysMatch[2] ?? '';
  return restOfPath
    ? `${driveLetter}:\\${restOfPath.replace(/\//g, '\\')}`
    : `${driveLetter}:`;
}
