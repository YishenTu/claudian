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

/**
 * Gets the npm global prefix directory.
 * Returns null if npm is not available or prefix cannot be determined.
 */
function getNpmGlobalPrefix(): string | null {
  // Check npm prefix environment variable first (set by some npm configurations)
  if (process.env.npm_config_prefix) {
    return process.env.npm_config_prefix;
  }

  // Check common custom npm prefix locations on Windows
  if (process.platform === 'win32') {
    // Custom npm global paths are often configured via npm config
    // Check %APPDATA%\npm first (default Windows npm global)
    const appDataNpm = process.env.APPDATA
      ? path.join(process.env.APPDATA, 'npm')
      : null;
    if (appDataNpm && fs.existsSync(appDataNpm)) {
      return appDataNpm;
    }
  }

  return null;
}

/**
 * Builds the list of paths to search for cli.js in npm's node_modules.
 */
function getNpmCliJsPaths(): string[] {
  const homeDir = os.homedir();
  const isWindows = process.platform === 'win32';
  const cliJsPaths: string[] = [];

  if (isWindows) {
    // Default npm global path on Windows
    cliJsPaths.push(
      path.join(homeDir, 'AppData', 'Roaming', 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js')
    );

    // npm prefix from environment/config
    const npmPrefix = getNpmGlobalPrefix();
    if (npmPrefix) {
      cliJsPaths.push(
        path.join(npmPrefix, 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js')
      );
    }

    // Common custom npm global directories on Windows
    const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
    const programFilesX86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';

    // Check common nodejs installation paths with custom npm global
    cliJsPaths.push(
      path.join(programFiles, 'nodejs', 'node_global', 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js'),
      path.join(programFilesX86, 'nodejs', 'node_global', 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js')
    );

    // Also check D: drive which is commonly used for custom installations
    cliJsPaths.push(
      path.join('D:', 'Program Files', 'nodejs', 'node_global', 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js')
    );
  } else {
    // Unix/macOS npm global paths
    cliJsPaths.push(
      path.join(homeDir, '.npm-global', 'lib', 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js'),
      '/usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js',
      '/usr/lib/node_modules/@anthropic-ai/claude-code/cli.js'
    );

    // Check npm_config_prefix for custom npm global paths on Unix
    if (process.env.npm_config_prefix) {
      cliJsPaths.push(
        path.join(process.env.npm_config_prefix, 'lib', 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js')
      );
    }
  }

  return cliJsPaths;
}

/** Finds Claude Code CLI executable in common install locations. */
export function findClaudeCLIPath(): string | null {
  const homeDir = os.homedir();
  const isWindows = process.platform === 'win32';

  // On Windows, prefer native .exe, then cli.js, and only use .cmd as last resort.
  // .cmd files cannot be spawned directly without shell: true, which breaks
  // the SDK's stdio pipe communication for stream-json mode.
  if (isWindows) {
    const exePaths: string[] = [
      path.join(homeDir, '.claude', 'local', 'claude.exe'),
      path.join(homeDir, 'AppData', 'Local', 'Claude', 'claude.exe'),
      path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Claude', 'claude.exe'),
      path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Claude', 'claude.exe'),
      path.join(homeDir, '.local', 'bin', 'claude.exe'),
    ];

    for (const p of exePaths) {
      if (fs.existsSync(p)) {
        return p;
      }
    }

    const cliJsPaths = getNpmCliJsPaths();
    for (const p of cliJsPaths) {
      if (fs.existsSync(p)) {
        return p;
      }
    }

    const cmdPaths: string[] = [
      path.join(homeDir, 'AppData', 'Roaming', 'npm', 'claude.cmd'),
    ];
    for (const p of cmdPaths) {
      if (fs.existsSync(p)) {
        return p;
      }
    }

    return null;
  }

  // Platform-specific search paths for native binaries
  const commonPaths: string[] = [
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

  // On Unix, also check for cli.js if binary not found
  if (!isWindows) {
    const cliJsPaths = getNpmCliJsPaths();
    for (const p of cliJsPaths) {
      if (fs.existsSync(p)) {
        return p;
      }
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

  // Allow full access to ~/.claude/ (agent's native directory)
  const claudeDir = normalizePathForComparison(resolveRealPath(path.join(os.homedir(), '.claude')));
  if (resolvedCandidate === claudeDir || resolvedCandidate.startsWith(claudeDir + path.sep)) {
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
