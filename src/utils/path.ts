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
  expanded = expanded.replace(/%([A-Za-z_][A-Za-z0-9_]*(?:\([A-Za-z0-9_]+\))?[A-Za-z0-9_]*)%/g, (match, name) => {
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

function stripSurroundingQuotes(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function isPathPlaceholder(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;
  if (trimmed === '$PATH' || trimmed === '${PATH}') return true;
  return trimmed.toUpperCase() === '%PATH%';
}

export function parsePathEntries(pathValue?: string): string[] {
  if (!pathValue) {
    return [];
  }

  const delimiter = process.platform === 'win32' ? ';' : ':';

  return pathValue
    .split(delimiter)
    .map(segment => stripSurroundingQuotes(segment.trim()))
    .filter(segment => segment.length > 0 && !isPathPlaceholder(segment))
    .map(segment => translateMsysPath(expandHomePath(segment)));
}

function dedupePaths(entries: string[]): string[] {
  const seen = new Set<string>();
  return entries.filter(entry => {
    const key = process.platform === 'win32' ? entry.toLowerCase() : entry;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function findFirstExistingPath(entries: string[], candidates: string[]): string | null {
  for (const dir of entries) {
    if (!dir) continue;
    for (const candidate of candidates) {
      const fullPath = path.join(dir, candidate);
      if (isExistingFile(fullPath)) {
        return fullPath;
      }
    }
  }
  return null;
}

function isExistingFile(filePath: string): boolean {
  try {
    if (fs.existsSync(filePath)) {
      const stat = fs.statSync(filePath);
      return stat.isFile();
    }
  } catch {
    // Ignore inaccessible paths
  }
  return false;
}

function resolveCliJsNearPathEntry(entry: string, isWindows: boolean): string | null {
  const directCandidate = path.join(entry, 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js');
  if (isExistingFile(directCandidate)) {
    return directCandidate;
  }

  const baseName = path.basename(entry).toLowerCase();
  if (baseName === 'bin') {
    const prefix = path.dirname(entry);
    const candidate = isWindows
      ? path.join(prefix, 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js')
      : path.join(prefix, 'lib', 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js');
    if (isExistingFile(candidate)) {
      return candidate;
    }
  }

  return null;
}

function resolveCliJsFromPathEntries(entries: string[], isWindows: boolean): string | null {
  for (const entry of entries) {
    const candidate = resolveCliJsNearPathEntry(entry, isWindows);
    if (candidate) {
      return candidate;
    }
  }
  return null;
}

function resolveClaudeFromPathEntries(
  entries: string[],
  isWindows: boolean
): string | null {
  if (entries.length === 0) {
    return null;
  }

  if (!isWindows) {
    const unixCandidate = findFirstExistingPath(entries, ['claude']);
    return unixCandidate;
  }

  const exeCandidate = findFirstExistingPath(entries, ['claude.exe', 'claude']);
  if (exeCandidate) {
    return exeCandidate;
  }

  const cliJsCandidate = resolveCliJsFromPathEntries(entries, isWindows);
  if (cliJsCandidate) {
    return cliJsCandidate;
  }

  return null;
}

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

/** Finds Claude Code CLI executable from PATH or common install locations. */
export function findClaudeCLIPath(pathValue?: string): string | null {
  const homeDir = os.homedir();
  const isWindows = process.platform === 'win32';

  const customEntries = dedupePaths(parsePathEntries(pathValue));

  if (customEntries.length > 0) {
    const customResolution = resolveClaudeFromPathEntries(customEntries, isWindows);
    if (customResolution) {
      return customResolution;
    }
  }

  // On Windows, prefer native .exe, then cli.js. Avoid .cmd fallback
  // because it requires shell: true and breaks SDK stdio streaming.
  if (isWindows) {
    const exePaths: string[] = [
      path.join(homeDir, '.claude', 'local', 'claude.exe'),
      path.join(homeDir, 'AppData', 'Local', 'Claude', 'claude.exe'),
      path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Claude', 'claude.exe'),
      path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Claude', 'claude.exe'),
      path.join(homeDir, '.local', 'bin', 'claude.exe'),
    ];

    for (const p of exePaths) {
      if (isExistingFile(p)) {
        return p;
      }
    }

    const cliJsPaths = getNpmCliJsPaths();
    for (const p of cliJsPaths) {
      if (isExistingFile(p)) {
        return p;
      }
    }

  }

  // Platform-specific search paths for native binaries and npm symlinks
  const commonPaths: string[] = [
    // Native binary paths (preferred)
    path.join(homeDir, '.claude', 'local', 'claude'),
    path.join(homeDir, '.local', 'bin', 'claude'),
    path.join(homeDir, '.volta', 'bin', 'claude'),
    path.join(homeDir, '.asdf', 'shims', 'claude'),
    path.join(homeDir, '.asdf', 'bin', 'claude'),
    '/usr/local/bin/claude',
    '/opt/homebrew/bin/claude',
    path.join(homeDir, 'bin', 'claude'),
    // npm global bin symlinks (created by npm install -g)
    path.join(homeDir, '.npm-global', 'bin', 'claude'),
  ];

  // Also check npm prefix bin directory
  const npmPrefix = getNpmGlobalPrefix();
  if (npmPrefix) {
    commonPaths.push(path.join(npmPrefix, 'bin', 'claude'));
  }

  for (const p of commonPaths) {
    if (isExistingFile(p)) {
      return p;
    }
  }

  // On Unix, also check for cli.js if binary not found
  if (!isWindows) {
    const cliJsPaths = getNpmCliJsPaths();
    for (const p of cliJsPaths) {
      if (isExistingFile(p)) {
        return p;
      }
    }
  }

  const envEntries = dedupePaths(parsePathEntries(getEnvValue('PATH')));
  if (envEntries.length > 0) {
    const envResolution = resolveClaudeFromPathEntries(envEntries, isWindows);
    if (envResolution) {
      return envResolution;
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

/**
 * Normalizes a path for filesystem operations (expand env/home, translate MSYS, strip Windows prefixes).
 * This is the main entry point for path normalization before file operations.
 */
export function normalizePathForFilesystem(value: string): string {
  if (!value || typeof value !== 'string') {
    return '';
  }
  const expanded = normalizePathBeforeResolution(value);
  let normalized = expanded;

  try {
    normalized = process.platform === 'win32'
      ? path.win32.normalize(expanded)
      : path.normalize(expanded);
  } catch {
    normalized = expanded;
  }

  return normalizeWindowsPathPrefix(normalized);
}

/**
 * Normalizes a path for comparison (case-insensitive on Windows, slashes normalized, trailing slash removed).
 * This is the main entry point for path comparisons and should be used consistently across modules.
 */
export function normalizePathForComparison(value: string): string {
  if (!value || typeof value !== 'string') {
    return '';
  }

  const expanded = normalizePathBeforeResolution(value);
  let normalized = expanded;

  try {
    normalized = process.platform === 'win32'
      ? path.win32.normalize(expanded)
      : path.normalize(expanded);
  } catch {
    normalized = expanded;
  }

  normalized = normalizeWindowsPathPrefix(normalized);
  normalized = normalized.replace(/\\/g, '/').replace(/\/+$/, '');

  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
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

  // Use '/' since normalizePathForComparison converts all paths to forward slashes
  return resolvedCandidate === vaultReal || resolvedCandidate.startsWith(vaultReal + '/');
}

/** Normalizes a path to vault-relative with forward slashes when inside the vault. */
export function normalizePathForVault(
  rawPath: string | undefined | null,
  vaultPath: string | null | undefined
): string | null {
  if (!rawPath) return null;

  const normalizedRaw = normalizePathForFilesystem(rawPath);
  if (!normalizedRaw) return null;

  if (vaultPath && isPathWithinVault(normalizedRaw, vaultPath)) {
    const absolute = path.isAbsolute(normalizedRaw)
      ? normalizedRaw
      : path.resolve(vaultPath, normalizedRaw);
    const relative = path.relative(vaultPath, absolute);
    return relative ? relative.replace(/\\/g, '/') : null;
  }

  return normalizedRaw.replace(/\\/g, '/');
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
    // Use '/' since normalizePathForComparison converts all paths to forward slashes
    if (
      resolvedCandidate === resolvedExport ||
      resolvedCandidate.startsWith(resolvedExport + '/')
    ) {
      return true;
    }
  }

  return false;
}

/** Checks whether a candidate path is within any of the allowed context paths. */
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
    // Use '/' since normalizePathForComparison converts all paths to forward slashes
    if (
      resolvedCandidate === resolvedContext ||
      resolvedCandidate.startsWith(resolvedContext + '/')
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

  // Use '/' since normalizePathForComparison converts all paths to forward slashes
  if (resolvedCandidate === vaultReal || resolvedCandidate.startsWith(vaultReal + '/')) {
    return 'vault';
  }

  // Allow full access to ~/.claude/ (agent's native directory)
  const claudeDir = normalizePathForComparison(resolveRealPath(path.join(os.homedir(), '.claude')));
  if (resolvedCandidate === claudeDir || resolvedCandidate.startsWith(claudeDir + '/')) {
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
    // Use '/' since normalizePathForComparison converts all paths to forward slashes
    if (resolvedCandidate === root || resolvedCandidate.startsWith(root + '/')) {
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
