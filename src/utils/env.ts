/**
 * Claudian - Environment Utilities
 *
 * Environment variable parsing, model configuration, PATH enhancement for GUI apps,
 * and system identification utilities.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { parsePathEntries, resolveNvmDefaultBin } from './path';

const isWindows = process.platform === 'win32';
const PATH_SEPARATOR = isWindows ? ';' : ':';
const NODE_EXECUTABLE = isWindows ? 'node.exe' : 'node';
const platformPath = isWindows ? path.win32 : path.posix;

function getHomeDir(): string {
  return process.env.HOME || process.env.USERPROFILE || '';
}

/**
 * Linux is excluded because Obsidian registers the CLI through stable symlinks
 * like /usr/local/bin or ~/.local/bin, while process.execPath may point to a
 * transient AppImage mount that changes on every launch.
 */
function getAppProvidedCliPaths(): string[] {
  if (process.platform === 'darwin') {
    const appBundleMatch = process.execPath.match(/^(.+?\.app)\//);
    if (appBundleMatch) {
      return [platformPath.join(appBundleMatch[1], 'Contents', 'MacOS')];
    }
    return [platformPath.dirname(process.execPath)];
  }

  if (process.platform === 'win32') {
    return [platformPath.dirname(process.execPath)];
  }

  return [];
}

/** GUI apps like Obsidian have minimal PATH, so we add common binary locations. */
function getExtraBinaryPaths(): string[] {
  const home = getHomeDir();

  if (isWindows) {
    const paths: string[] = [];
    const localAppData = process.env.LOCALAPPDATA;
    const appData = process.env.APPDATA;
    const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
    const programFilesX86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
    const programData = process.env.ProgramData || 'C:\\ProgramData';

    // Node.js / npm locations
    if (appData) {
      paths.push(platformPath.join(appData, 'npm'));
    }
    if (localAppData) {
      paths.push(platformPath.join(localAppData, 'Programs', 'nodejs'));
      paths.push(platformPath.join(localAppData, 'Programs', 'node'));
    }

    // Common program locations (official Node.js installer)
    paths.push(platformPath.join(programFiles, 'nodejs'));
    paths.push(platformPath.join(programFilesX86, 'nodejs'));

    // nvm-windows: active Node.js is usually under %NVM_SYMLINK%
    const nvmSymlink = process.env.NVM_SYMLINK;
    if (nvmSymlink) {
      paths.push(nvmSymlink);
    }

    // nvm-windows: stores Node.js versions in %NVM_HOME% or %APPDATA%\nvm
    const nvmHome = process.env.NVM_HOME;
    if (nvmHome) {
      paths.push(nvmHome);
    } else if (appData) {
      paths.push(platformPath.join(appData, 'nvm'));
    }

    // volta: installs to %VOLTA_HOME%\bin or %USERPROFILE%\.volta\bin
    const voltaHome = process.env.VOLTA_HOME;
    if (voltaHome) {
      paths.push(platformPath.join(voltaHome, 'bin'));
    } else if (home) {
      paths.push(platformPath.join(home, '.volta', 'bin'));
    }

    // fnm (Fast Node Manager): %FNM_MULTISHELL_PATH% is the active Node.js bin
    const fnmMultishell = process.env.FNM_MULTISHELL_PATH;
    if (fnmMultishell) {
      paths.push(fnmMultishell);
    }

    // fnm (Fast Node Manager): %FNM_DIR% or %LOCALAPPDATA%\fnm
    const fnmDir = process.env.FNM_DIR;
    if (fnmDir) {
      paths.push(fnmDir);
    } else if (localAppData) {
      paths.push(platformPath.join(localAppData, 'fnm'));
    }

    // Chocolatey: %ChocolateyInstall%\bin or C:\ProgramData\chocolatey\bin
    const chocolateyInstall = process.env.ChocolateyInstall;
    if (chocolateyInstall) {
      paths.push(platformPath.join(chocolateyInstall, 'bin'));
    } else {
      paths.push(platformPath.join(programData, 'chocolatey', 'bin'));
    }

    // scoop: %SCOOP%\shims or %USERPROFILE%\scoop\shims
    const scoopDir = process.env.SCOOP;
    if (scoopDir) {
      paths.push(platformPath.join(scoopDir, 'shims'));
      paths.push(platformPath.join(scoopDir, 'apps', 'nodejs', 'current', 'bin'));
      paths.push(platformPath.join(scoopDir, 'apps', 'nodejs', 'current'));
    } else if (home) {
      paths.push(platformPath.join(home, 'scoop', 'shims'));
      paths.push(platformPath.join(home, 'scoop', 'apps', 'nodejs', 'current', 'bin'));
      paths.push(platformPath.join(home, 'scoop', 'apps', 'nodejs', 'current'));
    }

    // Docker
    paths.push(platformPath.join(programFiles, 'Docker', 'Docker', 'resources', 'bin'));

    // User bin (if exists)
    if (home) {
      paths.push(platformPath.join(home, '.local', 'bin'));
    }

    paths.push(...getAppProvidedCliPaths());

    return paths;
  } else {
    // Unix paths
    const paths = [
      '/usr/local/bin',
      '/opt/homebrew/bin',  // macOS ARM Homebrew
      '/usr/bin',
      '/bin',
    ];

    const voltaHome = process.env.VOLTA_HOME;
    if (voltaHome) {
      paths.push(platformPath.join(voltaHome, 'bin'));
    }

    const asdfRoot = process.env.ASDF_DATA_DIR || process.env.ASDF_DIR;
    if (asdfRoot) {
      paths.push(platformPath.join(asdfRoot, 'shims'));
      paths.push(platformPath.join(asdfRoot, 'bin'));
    }

    const fnmMultishell = process.env.FNM_MULTISHELL_PATH;
    if (fnmMultishell) {
      paths.push(fnmMultishell);
    }

    const fnmDir = process.env.FNM_DIR;
    if (fnmDir) {
      paths.push(fnmDir);
    }

    if (home) {
      paths.push(platformPath.join(home, '.local', 'bin'));
      paths.push(platformPath.join(home, '.docker', 'bin'));
      paths.push(platformPath.join(home, '.volta', 'bin'));
      paths.push(platformPath.join(home, '.asdf', 'shims'));
      paths.push(platformPath.join(home, '.asdf', 'bin'));
      paths.push(platformPath.join(home, '.fnm'));

      // NVM: use NVM_BIN if set, otherwise resolve default version from filesystem
      const nvmBin = process.env.NVM_BIN;
      if (nvmBin) {
        paths.push(nvmBin);
      } else {
        const nvmDefault = resolveNvmDefaultBin(home);
        if (nvmDefault) {
          paths.push(nvmDefault);
        }
      }
    }

    paths.push(...getAppProvidedCliPaths());

    return paths;
  }
}

export function findNodeDirectory(additionalPaths?: string): string | null {
  const searchPaths = getExtraBinaryPaths();

  const currentPath = process.env.PATH || '';
  const pathDirs = parsePathEntries(currentPath);
  const additionalDirs = additionalPaths ? parsePathEntries(additionalPaths) : [];
  const allPaths = [...additionalDirs, ...searchPaths, ...pathDirs];

  for (const dir of allPaths) {
    if (!dir) continue;
    try {
      const nodePath = platformPath.join(dir, NODE_EXECUTABLE);
      if (fs.existsSync(nodePath)) {
        const stat = fs.statSync(nodePath);
        if (stat.isFile()) {
          return dir;
        }
      }
    } catch {
      // Inaccessible directory
    }
  }

  return null;
}

export function findNodeExecutable(additionalPaths?: string): string | null {
  const nodeDir = findNodeDirectory(additionalPaths);
  if (nodeDir) {
    return platformPath.join(nodeDir, NODE_EXECUTABLE);
  }
  return null;
}

export function cliPathRequiresNode(cliPath: string): boolean {
  const jsExtensions = ['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx'];
  const lower = cliPath.toLowerCase();
  if (jsExtensions.some(ext => lower.endsWith(ext))) {
    return true;
  }

  try {
    if (!fs.existsSync(cliPath)) {
      return false;
    }

    const stat = fs.statSync(cliPath);
    if (!stat.isFile()) {
      return false;
    }

    let fd: number | null = null;
    try {
      fd = fs.openSync(cliPath, 'r');
      const buffer = Buffer.alloc(200);
      const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, 0);
      const header = buffer.slice(0, bytesRead).toString('utf8');
      return header.startsWith('#!') && header.toLowerCase().includes('node');
    } finally {
      if (fd !== null) {
        try {
          fs.closeSync(fd);
        } catch {
          // Ignore close errors
        }
      }
    }
  } catch {
    return false;
  }
}

export function getMissingNodeError(cliPath: string, enhancedPath?: string): string | null {
  if (!cliPathRequiresNode(cliPath)) {
    return null;
  }

  const nodePath = findNodeExecutable(enhancedPath);
  if (nodePath) {
    return null;
  }

  return 'Claude Code CLI requires Node.js, but Node was not found on PATH. Install Node.js or use the native Claude Code binary, then restart Obsidian.';
}

/**
 * Returns an enhanced PATH that includes common binary locations.
 * GUI apps like Obsidian have minimal PATH, so we need to add standard locations
 * where binaries like node, python, etc. are typically installed.
 *
 * @param additionalPaths - Optional additional PATH entries to include (from user config).
 *                          These take priority and are prepended.
 * @param cliPath - Optional CLI path. If provided and its directory contains node,
 *                  that directory is added to PATH. This handles nvm, fnm, volta, etc.
 *                  where npm globals are installed alongside node.
 */
export function getEnhancedPath(additionalPaths?: string, cliPath?: string): string {
  const extraPaths = getExtraBinaryPaths().filter(p => p); // Filter out empty
  const currentPath = process.env.PATH || '';
  const rawCurrentPathDirs = currentPath
    .split(PATH_SEPARATOR)
    .map(s => s.trim())
    .filter(s => s.length > 0);
  const currentPathDirs = currentPath ? parsePathEntries(currentPath) : [];

  const segments: string[] = [];

  if (additionalPaths) {
    segments.push(...parsePathEntries(additionalPaths));
  }

  // If CLI path is provided, check if its directory contains node executable.
  // This handles nvm, fnm, volta, asdf, etc. where npm globals are installed
  // in the same bin directory as node. Works on both Windows and Unix.
  let cliDirHasNode = false;
  if (cliPath) {
    try {
      const cliDir = path.dirname(cliPath);
      const nodeInCliDir = path.join(cliDir, NODE_EXECUTABLE);
      if (fs.existsSync(nodeInCliDir)) {
        const stat = fs.statSync(nodeInCliDir);
        if (stat.isFile()) {
          segments.push(cliDir);
          cliDirHasNode = true;
        }
      }
    } catch {
      // Ignore errors checking CLI directory
    }
  }

  if (cliPath && cliPathRequiresNode(cliPath) && !cliDirHasNode) {
    const nodeDirFromCurrentPath = rawCurrentPathDirs.find(dir => {
      try {
        const nodePath = platformPath.join(dir, NODE_EXECUTABLE);
        if (!fs.existsSync(nodePath)) return false;
        return fs.statSync(nodePath).isFile();
      } catch {
        return false;
      }
    });

    const nodeDir = nodeDirFromCurrentPath || findNodeDirectory(currentPath);
    if (nodeDir) {
      segments.push(nodeDir);
    }
  }

  segments.push(...extraPaths);

  segments.push(...currentPathDirs);

  const seen = new Set<string>();
  const unique = segments.filter(p => {
    const trimmed = p.trim();
    if (!trimmed) return false;
    const normalized = isWindows ? trimmed.toLowerCase() : trimmed;
    if (seen.has(normalized)) return false;
    seen.add(normalized);
    return true;
  }).map(p => p.trim());

  return unique.join(PATH_SEPARATOR)
    .split(PATH_SEPARATOR)
    .filter(s => s.length > 0)
    .join(PATH_SEPARATOR);
}

const CUSTOM_MODEL_ENV_KEYS = [
  'ANTHROPIC_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
] as const;

function getModelTypeFromEnvKey(envKey: string): string {
  if (envKey === 'ANTHROPIC_MODEL') return 'model';
  const match = envKey.match(/ANTHROPIC_DEFAULT_(\w+)_MODEL/);
  return match ? match[1].toLowerCase() : envKey;
}

/** Parses KEY=VALUE environment variables from text. Supports comments (#) and empty lines. */
export function parseEnvironmentVariables(input: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of input.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    // Strip 'export ' prefix if present (common in shell snippets)
    const normalized = trimmed.startsWith('export ') ? trimmed.slice(7) : trimmed;
    const eqIndex = normalized.indexOf('=');
    if (eqIndex > 0) {
      const key = normalized.substring(0, eqIndex).trim();
      let value = normalized.substring(eqIndex + 1).trim();
      // Strip surrounding quotes (single or double)
      if ((value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      if (key) {
        result[key] = value;
      }
    }
  }
  return result;
}

export function getModelsFromEnvironment(envVars: Record<string, string>): { value: string; label: string; description: string }[] {
  const modelMap = new Map<string, { types: string[]; label: string }>();

  for (const envKey of CUSTOM_MODEL_ENV_KEYS) {
    const type = getModelTypeFromEnvKey(envKey);
    const modelValue = envVars[envKey];
    if (modelValue) {
      const label = modelValue.includes('/')
        ? modelValue.split('/').pop() || modelValue
        : modelValue.replace(/-/g, ' ').replace(/\b\w/g, l => l.toUpperCase());

      if (!modelMap.has(modelValue)) {
        modelMap.set(modelValue, { types: [type], label });
      } else {
        modelMap.get(modelValue)!.types.push(type);
      }
    }
  }

  const models: { value: string; label: string; description: string }[] = [];
  const typePriority = { 'model': 4, 'haiku': 3, 'sonnet': 2, 'opus': 1 };

  const sortedEntries = Array.from(modelMap.entries()).sort(([, aInfo], [, bInfo]) => {
    const aPriority = Math.max(...aInfo.types.map(t => typePriority[t as keyof typeof typePriority] || 0));
    const bPriority = Math.max(...bInfo.types.map(t => typePriority[t as keyof typeof typePriority] || 0));
    return bPriority - aPriority;
  });

  for (const [modelValue, info] of sortedEntries) {
    const sortedTypes = info.types.sort((a, b) =>
      (typePriority[b as keyof typeof typePriority] || 0) -
      (typePriority[a as keyof typeof typePriority] || 0)
    );

    models.push({
      value: modelValue,
      label: info.label,
      description: `Custom model (${sortedTypes.join(', ')})`
    });
  }

  return models;
}

export function getCurrentModelFromEnvironment(envVars: Record<string, string>): string | null {
  if (envVars.ANTHROPIC_MODEL) {
    return envVars.ANTHROPIC_MODEL;
  }
  if (envVars.ANTHROPIC_DEFAULT_HAIKU_MODEL) {
    return envVars.ANTHROPIC_DEFAULT_HAIKU_MODEL;
  }
  if (envVars.ANTHROPIC_DEFAULT_SONNET_MODEL) {
    return envVars.ANTHROPIC_DEFAULT_SONNET_MODEL;
  }
  if (envVars.ANTHROPIC_DEFAULT_OPUS_MODEL) {
    return envVars.ANTHROPIC_DEFAULT_OPUS_MODEL;
  }
  return null;
}

/** Hostname changes will require reconfiguration. */
export function getHostnameKey(): string {
  return os.hostname();
}

export const MIN_CONTEXT_LIMIT = 1_000;
export const MAX_CONTEXT_LIMIT = 10_000_000;

export function getCustomModelIds(envVars: Record<string, string>): Set<string> {
  const modelIds = new Set<string>();
  for (const envKey of CUSTOM_MODEL_ENV_KEYS) {
    const modelId = envVars[envKey];
    if (modelId) {
      modelIds.add(modelId);
    }
  }
  return modelIds;
}

/** Supports "256k", "1m", "1.5m", or exact token count. Case-insensitive. */
export function parseContextLimit(input: string): number | null {
  const trimmed = input.trim().toLowerCase().replace(/,/g, '');
  if (!trimmed) return null;

  // Match number with optional suffix (k, m)
  const match = trimmed.match(/^(\d+(?:\.\d+)?)\s*(k|m)?$/);
  if (!match) return null;

  const value = parseFloat(match[1]);
  const suffix = match[2];

  if (isNaN(value) || value <= 0) return null;

  const MULTIPLIERS: Record<string, number> = { k: 1_000, m: 1_000_000 };
  const multiplier = suffix ? MULTIPLIERS[suffix] ?? 1 : 1;
  const result = Math.round(value * multiplier);

  if (result < MIN_CONTEXT_LIMIT || result > MAX_CONTEXT_LIMIT) return null;

  return result;
}

export function formatContextLimit(tokens: number): string {
  if (tokens >= 1_000_000 && tokens % 1_000_000 === 0) {
    return `${tokens / 1_000_000}m`;
  }
  if (tokens >= 1000 && tokens % 1000 === 0) {
    return `${tokens / 1000}k`;
  }
  return tokens.toLocaleString();
}
