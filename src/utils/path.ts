/**
 * Claudian - Path Utilities
 *
 * Path resolution, validation, and access control for vault operations.
 */

import * as fs from 'fs';
import type { App } from 'obsidian';
import * as os from 'os';
import * as path from 'path';

// ============================================
// Vault Path
// ============================================

/** Returns the vault's absolute file path, or null if unavailable. */
export function getVaultPath(app: App): string | null {
  const adapter = app.vault.adapter;
  if ('basePath' in adapter) {
    return (adapter as any).basePath;
  }
  return null;
}

// ============================================
// Home Path Expansion
// ============================================

/**
 * Checks if a path starts with home directory notation (~/path or ~\path).
 * Supports both Unix-style (~/) and Windows-style (~\) home directory notation.
 */
export function startsWithHomePath(p: string): boolean {
  return p.startsWith('~/') || p.startsWith('~\\') || p === '~';
}

function getEnvValue(key: string): string | undefined {
  const hasKey = (name: string) => Object.prototype.hasOwnProperty.call(process.env, name);

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
  expanded = expanded.replace(/%([A-Za-z_][A-Za-z0-9_()]*[A-Za-z0-9_)]?)%/g, (match, name) => {
    const envValue = getEnvValue(name);
    return envValue !== undefined ? envValue : match;
  });

  if (isWindows) {
    expanded = expanded.replace(/!([A-Za-z_][A-Za-z0-9_]*)!/g, (match, name) => {
      const envValue = getEnvValue(name);
      return envValue !== undefined ? envValue : match;
    });

    expanded = expanded.replace(/\$env:([A-Za-z_][A-Za-z0-9_]*)/gi, (match, name) => {
      const envValue = getEnvValue(name);
      return envValue !== undefined ? envValue : match;
    });
  }

  expanded = expanded.replace(/\$([A-Za-z_][A-Za-z0-9_]*)|\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (match, name1, name2) => {
    const key = name1 ?? name2;
    if (!key) return match;
    const envValue = getEnvValue(key);
    return envValue !== undefined ? envValue : match;
  });

  return expanded;
}

/**
 * Expands home directory notation to absolute path.
 * Handles both ~/path and ~\path formats.
 */
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

// ============================================
// Claude CLI Detection
// ============================================

/** Finds Claude Code CLI executable in common install locations. */
export function findClaudeCLIPath(): string | null {
  const homeDir = os.homedir();
  const isWindows = process.platform === 'win32';

  // Platform-specific search paths
  const commonPaths: string[] = isWindows
    ? [
        // Windows paths
        path.join(homeDir, '.claude', 'local', 'claude.exe'),
        path.join(homeDir, 'AppData', 'Local', 'Claude', 'claude.exe'),
        path.join(homeDir, 'AppData', 'Roaming', 'npm', 'claude.cmd'),
        path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Claude', 'claude.exe'),
        path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Claude', 'claude.exe'),
        path.join(homeDir, '.local', 'bin', 'claude.exe'),
      ]
    : [
        // Unix/macOS paths
        path.join(homeDir, '.claude', 'local', 'claude'),
        path.join(homeDir, '.local', 'bin', 'claude'),
        '/usr/local/bin/claude',
        '/opt/homebrew/bin/claude',
        path.join(homeDir, 'bin', 'claude'),
      ];

  for (const p of commonPaths) {
    if (fs.existsSync(p)) {
      return p;
    }
  }

  return null;
}

// ============================================
// Path Resolution
// ============================================

/**
 * Best-effort realpath that stays symlink-aware even when the target does not exist.
 *
 * If the full path doesn't exist, resolve the nearest existing ancestor via realpath
 * and then re-append the remaining path segments.
 */
function resolveRealPath(p: string): string {
  const realpathFn = (fs.realpathSync.native ?? fs.realpathSync) as (path: fs.PathLike) => string;

  try {
    return realpathFn(p);
  } catch {
    const absolute = path.resolve(p);
    let current = absolute;
    const suffix: string[] = [];

    // eslint-disable-next-line no-constant-condition
    while (true) {
      try {
        if (fs.existsSync(current)) {
          const resolvedExisting = realpathFn(current);
          return suffix.length > 0
            ? path.join(resolvedExisting, ...suffix.reverse())
            : resolvedExisting;
        }
      } catch {
        // Ignore and keep walking up the directory tree.
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

/**
 * Translates MSYS/Git Bash paths to Windows paths.
 * E.g., /c/Users/... → C:\Users\...
 *
 * This must be called BEFORE path.resolve() or path.isAbsolute() checks,
 * as those functions don't recognize MSYS-style drive paths.
 */
export function translateMsysPath(value: string): string {
  if (process.platform !== 'win32') {
    return value;
  }

  // Match /c/... or /C/... (single letter drive)
  const msysMatch = value.match(/^\/([a-zA-Z])(\/.*)?$/);
  if (msysMatch) {
    const driveLetter = msysMatch[1].toUpperCase();
    const restOfPath = msysMatch[2] ?? '';
    // Convert forward slashes to backslashes for the rest of the path
    return `${driveLetter}:${restOfPath.replace(/\//g, '\\')}`;
  }

  return value;
}

/**
 * Normalizes a path for cross-platform use before resolution.
 * Handles MSYS path translation and home directory expansion.
 * Call this before path.resolve() or path.isAbsolute() checks.
 */
function normalizePathBeforeResolution(p: string): string {
  // First expand environment variables and home path
  const expanded = expandHomePath(p);
  // Then translate MSYS paths on Windows (must happen before path.resolve)
  return translateMsysPath(expanded);
}

function normalizeWindowsPathPrefix(value: string): string {
  if (process.platform !== 'win32') {
    return value;
  }

  // First translate MSYS/Git Bash paths
  const normalized = translateMsysPath(value);

  if (normalized.startsWith('\\\\?\\UNC\\')) {
    return `\\\\${normalized.slice('\\\\?\\UNC\\'.length)}`;
  }

  if (normalized.startsWith('\\\\?\\')) {
    return normalized.slice('\\\\?\\'.length);
  }

  return normalized;
}

function normalizePathForComparison(value: string): string {
  if (!value || typeof value !== 'string') {
    return '';
  }
  try {
    const normalized = normalizeWindowsPathPrefix(path.normalize(value));
    return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
  } catch {
    // Fallback to input if normalization fails
    return process.platform === 'win32' ? value.toLowerCase() : value;
  }
}

// ============================================
// Path Access Control
// ============================================

/** Checks whether a candidate path is within the vault. */
export function isPathWithinVault(candidatePath: string, vaultPath: string): boolean {
  const vaultReal = normalizePathForComparison(resolveRealPath(vaultPath));

  // Normalize before resolution to handle MSYS paths on Windows
  const normalizedPath = normalizePathBeforeResolution(candidatePath);

  const absCandidate = path.isAbsolute(normalizedPath)
    ? normalizedPath
    : path.resolve(vaultPath, normalizedPath);

  const resolvedCandidate = normalizePathForComparison(resolveRealPath(absCandidate));

  return resolvedCandidate === vaultReal || resolvedCandidate.startsWith(vaultReal + path.sep);
}

/** Checks whether a candidate path is within any of the allowed export paths. */
export function isPathInAllowedExportPaths(
  candidatePath: string,
  allowedExportPaths: string[],
  vaultPath: string
): boolean {
  if (!allowedExportPaths || allowedExportPaths.length === 0) {
    return false;
  }

  // Normalize before resolution to handle MSYS paths on Windows
  const normalizedCandidate = normalizePathBeforeResolution(candidatePath);

  const absCandidate = path.isAbsolute(normalizedCandidate)
    ? normalizedCandidate
    : path.resolve(vaultPath, normalizedCandidate);

  const resolvedCandidate = normalizePathForComparison(resolveRealPath(absCandidate));

  // Check if candidate is within any allowed export path
  for (const exportPath of allowedExportPaths) {
    const normalizedExport = normalizePathBeforeResolution(exportPath);

    const resolvedExport = normalizePathForComparison(resolveRealPath(normalizedExport));

    // Check if candidate equals or is within the export path
    if (
      resolvedCandidate === resolvedExport ||
      resolvedCandidate.startsWith(resolvedExport + path.sep)
    ) {
      return true;
    }
  }

  return false;
}

/** Checks whether a candidate path is within any of the allowed context paths (read-only). */
export function isPathInAllowedContextPaths(
  candidatePath: string,
  allowedContextPaths: string[],
  vaultPath: string
): boolean {
  if (!allowedContextPaths || allowedContextPaths.length === 0) {
    return false;
  }

  // Normalize before resolution to handle MSYS paths on Windows
  const normalizedCandidate = normalizePathBeforeResolution(candidatePath);

  const absCandidate = path.isAbsolute(normalizedCandidate)
    ? normalizedCandidate
    : path.resolve(vaultPath, normalizedCandidate);

  const resolvedCandidate = normalizePathForComparison(resolveRealPath(absCandidate));

  // Check if candidate is within any allowed context path
  for (const contextPath of allowedContextPaths) {
    const normalizedContext = normalizePathBeforeResolution(contextPath);

    const resolvedContext = normalizePathForComparison(resolveRealPath(normalizedContext));

    // Check if candidate equals or is within the context path
    if (
      resolvedCandidate === resolvedContext ||
      resolvedCandidate.startsWith(resolvedContext + path.sep)
    ) {
      return true;
    }
  }

  return false;
}

export type PathAccessType = 'vault' | 'readwrite' | 'context' | 'export' | 'none';

/**
 * Resolve access type for a candidate path with context/export overlap handling.
 * The most specific matching root wins; exact context+export matches are read-write.
 */
export function getPathAccessType(
  candidatePath: string,
  allowedContextPaths: string[] | undefined,
  allowedExportPaths: string[] | undefined,
  vaultPath: string
): PathAccessType {
  if (!candidatePath) return 'none';

  const vaultReal = normalizePathForComparison(resolveRealPath(vaultPath));

  // Normalize before resolution to handle MSYS paths on Windows
  const normalizedCandidate = normalizePathBeforeResolution(candidatePath);

  const absCandidate = path.isAbsolute(normalizedCandidate)
    ? normalizedCandidate
    : path.resolve(vaultPath, normalizedCandidate);

  const resolvedCandidate = normalizePathForComparison(resolveRealPath(absCandidate));

  if (resolvedCandidate === vaultReal || resolvedCandidate.startsWith(vaultReal + path.sep)) {
    return 'vault';
  }

  const roots = new Map<string, { context: boolean; export: boolean }>();

  const addRoot = (rawPath: string, kind: 'context' | 'export') => {
    const trimmed = rawPath.trim();
    if (!trimmed) return;
    // Normalize before resolution to handle MSYS paths on Windows
    const normalized = normalizePathBeforeResolution(trimmed);
    const resolved = normalizePathForComparison(resolveRealPath(normalized));
    const existing = roots.get(resolved) ?? { context: false, export: false };
    existing[kind] = true;
    roots.set(resolved, existing);
  };

  for (const contextPath of allowedContextPaths ?? []) {
    addRoot(contextPath, 'context');
  }

  for (const exportPath of allowedExportPaths ?? []) {
    addRoot(exportPath, 'export');
  }

  let bestRoot: string | null = null;
  let bestFlags: { context: boolean; export: boolean } | null = null;

  for (const [root, flags] of roots) {
    if (resolvedCandidate === root || resolvedCandidate.startsWith(root + path.sep)) {
      if (!bestRoot || root.length > bestRoot.length) {
        bestRoot = root;
        bestFlags = flags;
      }
    }
  }

  if (!bestRoot || !bestFlags) return 'none';
  if (bestFlags.context && bestFlags.export) return 'readwrite';
  if (bestFlags.context) return 'context';
  if (bestFlags.export) return 'export';
  return 'none';
}
