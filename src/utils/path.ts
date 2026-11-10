import * as fs from 'fs';
import type { App } from 'obsidian';
import * as os from 'os';
import * as path from 'path';

export function getVaultPath(app: App): string | null {
  const basePath = (app.vault.adapter as { basePath?: unknown } | undefined)?.basePath;
  return typeof basePath === 'string' ? basePath : null;
}

function getEnvValue(key: string): string | undefined {
  const hasKey = (name: string): boolean => name in process.env && process.env[name] !== undefined;

  if (hasKey(key)) {
    return process.env[key];
  }

  if (process.platform !== 'win32') {
    return undefined;
  }

  const upper = key.toUpperCase();
  if (hasKey(upper)) {
    return process.env[upper];
  }

  const lower = key.toLowerCase();
  if (hasKey(lower)) {
    return process.env[lower];
  }

  const matchKey = Object.keys(process.env).find((name) => name.toLowerCase() === key.toLowerCase());
  return matchKey ? process.env[matchKey] : undefined;
}

function expandEnvironmentVariables(value: string): string {
  if (!value.includes('%') && !value.includes('$') && !value.includes('!')) {
    return value;
  }

  const isWindows = process.platform === 'win32';
  let expanded = value;

  // Windows %VAR% format - allow parentheses for vars like %ProgramFiles(x86)%
  expanded = expanded.replace(/%([A-Za-z_][A-Za-z0-9_]*(?:\([A-Za-z0-9_]+\))?[A-Za-z0-9_]*)%/g, (match: string, name: string): string => {
    const envValue = getEnvValue(name);
    return envValue !== undefined ? envValue : match;
  });

  if (isWindows) {
    expanded = expanded.replace(/!([A-Za-z_][A-Za-z0-9_]*)!/g, (match: string, name: string): string => {
      const envValue = getEnvValue(name);
      return envValue !== undefined ? envValue : match;
    });

    expanded = expanded.replace(/\$env:([A-Za-z_][A-Za-z0-9_]*)/gi, (match: string, name: string): string => {
      const envValue = getEnvValue(name);
      return envValue !== undefined ? envValue : match;
    });
  }

  expanded = expanded.replace(/\$([A-Za-z_][A-Za-z0-9_]*)|\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (match: string, name1: string | undefined, name2: string | undefined): string => {
    const key = name1 ?? name2;
    if (!key) return match;
    const envValue = getEnvValue(key);
    return envValue !== undefined ? envValue : match;
  });

  return expanded;
}

export function expandHomePath(p: string): string {
  const expanded = expandEnvironmentVariables(p);
  if (expanded === '~') {
    return os.homedir();
  }
  if (expanded.startsWith('~/')) {
    return path.join(os.homedir(), expanded.slice(2));
  }
  if (expanded.startsWith('~\\')) {
    return path.join(os.homedir(), expanded.slice(2));
  }
  return expanded;
}

// Best-effort realpath: if the full path doesn't exist, resolve the nearest
// existing ancestor and re-append the remaining segments.
function resolveRealPath(p: string): string {
  const realpathFn = (fs.realpathSync.native ?? fs.realpathSync) as (path: fs.PathLike) => string;

  try {
    return realpathFn(p);
  } catch {
    const absolute = path.resolve(p);
    let current = absolute;
    const suffix: string[] = [];

    for (;;) {
      try {
        if (fs.existsSync(current)) {
          const resolvedExisting = realpathFn(current);
          return suffix.length > 0
            ? path.join(resolvedExisting, ...suffix.reverse())
            : resolvedExisting;
        }
      } catch {
        // Keep walking up
      }

      const parent = path.dirname(current);
      if (parent === current) {
        return absolute;
      }

      suffix.push(path.basename(current));
      current = parent;
    }
  }
}

// Translates MSYS/Git Bash paths (/c/Users/...) to Windows paths (C:\Users\...).
// Must be called before path.resolve() or path.isAbsolute().
export function translateMsysPath(value: string): string {
  if (process.platform !== 'win32') {
    return value;
  }

  const msysMatch = value.match(/^\/([a-zA-Z])(\/.*)?$/);
  if (msysMatch) {
    const driveLetter = msysMatch[1].toUpperCase();
    const restOfPath = msysMatch[2] ?? '/';
    return `${driveLetter}:${restOfPath.replace(/\//g, '\\')}`;
  }

  return value;
}

function normalizePathBeforeResolution(p: string, expandConfiguration: boolean): string {
  const expanded = expandConfiguration ? expandHomePath(p) : p;
  return translateMsysPath(expanded);
}

function normalizeWindowsPathPrefix(value: string): string {
  if (process.platform !== 'win32') {
    return value;
  }

  const normalized = translateMsysPath(value);

  if (normalized.startsWith('\\\\?\\UNC\\')) {
    return `\\\\${normalized.slice('\\\\?\\UNC\\'.length)}`;
  }

  if (normalized.startsWith('\\\\?\\')) {
    return normalized.slice('\\\\?\\'.length);
  }

  return normalized;
}

function normalizeFilesystemPath(value: string, expandConfiguration: boolean): string {
  if (!value || typeof value !== 'string') {
    return '';
  }
  const expanded = normalizePathBeforeResolution(value, expandConfiguration);
  const normalized = (() => {
    try {
      return process.platform === 'win32'
        ? path.win32.normalize(expanded)
        : path.normalize(expanded);
    } catch {
      return expanded;
    }
  })();

  return normalizeWindowsPathPrefix(normalized);
}

export function normalizePathForFilesystem(value: string): string {
  return normalizeFilesystemPath(value, true);
}

function normalizeComparisonPath(value: string, expandConfiguration: boolean): string {
  const normalizedWithPrefix = normalizeFilesystemPath(value, expandConfiguration)
    .replace(/\\/g, '/')
    .replace(/\/+$/, '');

  return process.platform === 'win32'
    ? normalizedWithPrefix.toLowerCase()
    : normalizedWithPrefix;
}

export function normalizePathForComparison(value: string): string {
  return normalizeComparisonPath(value, true);
}

function normalizeVaultEventPath(value: string): string {
  return value
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/\/+$/, '');
}

export function rewriteVaultPathAfterRename(
  value: string,
  oldPath: string,
  newPath: string,
  includeDescendants = false,
): string | null {
  const normalizedValue = normalizeVaultEventPath(value);
  const normalizedOldPath = normalizeVaultEventPath(oldPath);
  const normalizedNewPath = normalizeVaultEventPath(newPath);
  if (!normalizedValue || !normalizedOldPath || !normalizedNewPath) return null;

  if (normalizedValue === normalizedOldPath) {
    return normalizedNewPath;
  }
  if (
    includeDescendants
    && normalizedValue.startsWith(`${normalizedOldPath}/`)
  ) {
    return `${normalizedNewPath}${normalizedValue.slice(normalizedOldPath.length)}`;
  }
  return null;
}

function isPathWithinDirectoryWithMode(
  candidatePath: string,
  directoryPath: string,
  relativeBasePath: string | undefined,
  expandConfiguration: boolean,
): boolean {
  if (!candidatePath || !directoryPath) {
    return false;
  }

  const directoryReal = normalizeComparisonPath(resolveRealPath(directoryPath), expandConfiguration);
  const normalizedCandidate = normalizeFilesystemPath(candidatePath, expandConfiguration);
  if (!normalizedCandidate) {
    return false;
  }

  const absCandidate = path.isAbsolute(normalizedCandidate)
    ? normalizedCandidate
    : path.resolve(relativeBasePath ?? directoryPath, normalizedCandidate);

  const resolvedCandidate = normalizeComparisonPath(resolveRealPath(absCandidate), expandConfiguration);
  return resolvedCandidate === directoryReal || resolvedCandidate.startsWith(directoryReal + '/');
}

export function isPathWithinDirectory(
  candidatePath: string,
  directoryPath: string,
  relativeBasePath?: string,
): boolean {
  return isPathWithinDirectoryWithMode(candidatePath, directoryPath, relativeBasePath, true);
}

export function isPathWithinVault(candidatePath: string, vaultPath: string): boolean {
  return isPathWithinDirectory(candidatePath, vaultPath, vaultPath);
}

export function normalizePathForVault(
  rawPath: string | undefined | null,
  vaultPath: string | null | undefined
): string | null {
  if (!rawPath) return null;

  const normalizedRaw = normalizeFilesystemPath(rawPath, false);
  if (!normalizedRaw) return null;

  if (vaultPath && isPathWithinDirectoryWithMode(normalizedRaw, vaultPath, vaultPath, false)) {
    const absolute = path.isAbsolute(normalizedRaw)
      ? normalizedRaw
      : path.resolve(vaultPath, normalizedRaw);
    let relative = path.relative(vaultPath, absolute);
    // Providers may report a canonical path while the vault was opened through a symlink.
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      relative = path.relative(resolveRealPath(vaultPath), resolveRealPath(absolute));
    }
    return relative ? relative.replace(/\\/g, '/') : null;
  }

  return normalizedRaw.replace(/\\/g, '/');
}
