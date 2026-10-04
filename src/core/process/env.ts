import * as fs from 'fs';
import * as path from 'path';

import { parsePathEntries, resolveNvmDefaultBin } from './cliPath';

const isWindows = process.platform === 'win32';
const PATH_SEPARATOR = isWindows ? ';' : ':';
const NODE_EXECUTABLE = isWindows ? 'node.exe' : 'node';

function getHomeDir(): string {
  return process.env.HOME || process.env.USERPROFILE || '';
}

function getMiseShimsDir(home: string): string | null {
  if (process.env.MISE_SHIMS_DIR) return process.env.MISE_SHIMS_DIR;
  if (process.env.MISE_DATA_DIR) return path.join(process.env.MISE_DATA_DIR, 'shims');
  if (process.env.XDG_DATA_HOME) return path.join(process.env.XDG_DATA_HOME, 'mise', 'shims');

  if (isWindows) {
    const localAppData = process.env.LOCALAPPDATA
      || (home ? path.join(home, 'AppData', 'Local') : null);
    return localAppData ? path.join(localAppData, 'mise', 'shims') : null;
  }

  return home ? path.join(home, '.local', 'share', 'mise', 'shims') : null;
}

// Windows ships Obsidian.com beside the app. Unix uses registered CLI locations;
// adding the macOS app directory can select the GUI executable as `obsidian`.
function getAppProvidedCLIPaths(): string[] {
  if (process.platform === 'win32') {
    return [path.dirname(process.execPath)];
  }

  return [];
}

/** GUI apps like Obsidian have minimal PATH, so we add common binary locations. */
function getExtraBinaryPaths(): string[] {
  const home = getHomeDir();
  const paths: string[] = [];

  if (isWindows) {
    const localAppData = process.env.LOCALAPPDATA;
    const appData = process.env.APPDATA;
    const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
    const programFilesX86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
    const programData = process.env.ProgramData || 'C:\\ProgramData';

    // Node.js / npm locations
    if (appData) {
      paths.push(path.join(appData, 'npm'));
    }
    if (localAppData) {
      paths.push(path.join(localAppData, 'Programs', 'nodejs'));
      paths.push(path.join(localAppData, 'Programs', 'node'));
    }

    // Common program locations (official Node.js installer)
    paths.push(path.join(programFiles, 'nodejs'));
    paths.push(path.join(programFilesX86, 'nodejs'));

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
      paths.push(path.join(appData, 'nvm'));
    }

    // volta: installs to %VOLTA_HOME%\bin or %USERPROFILE%\.volta\bin
    const voltaHome = process.env.VOLTA_HOME;
    if (voltaHome) {
      paths.push(path.join(voltaHome, 'bin'));
    } else if (home) {
      paths.push(path.join(home, '.volta', 'bin'));
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
      paths.push(path.join(localAppData, 'fnm'));
    }

    // Chocolatey: %ChocolateyInstall%\bin or C:\ProgramData\chocolatey\bin
    const chocolateyInstall = process.env.ChocolateyInstall;
    if (chocolateyInstall) {
      paths.push(path.join(chocolateyInstall, 'bin'));
    } else {
      paths.push(path.join(programData, 'chocolatey', 'bin'));
    }

    // scoop: %SCOOP%\shims or %USERPROFILE%\scoop\shims
    const scoopDir = process.env.SCOOP;
    if (scoopDir) {
      paths.push(path.join(scoopDir, 'shims'));
      paths.push(path.join(scoopDir, 'apps', 'nodejs', 'current', 'bin'));
      paths.push(path.join(scoopDir, 'apps', 'nodejs', 'current'));
    } else if (home) {
      paths.push(path.join(home, 'scoop', 'shims'));
      paths.push(path.join(home, 'scoop', 'apps', 'nodejs', 'current', 'bin'));
      paths.push(path.join(home, 'scoop', 'apps', 'nodejs', 'current'));
    }

    // Docker
    paths.push(path.join(programFiles, 'Docker', 'Docker', 'resources', 'bin'));

    // User bin (if exists)
    if (home) {
      paths.push(path.join(home, 'bin'));
      paths.push(path.join(home, '.local', 'bin'));
      paths.push(path.join(home, '.bun', 'bin'));
      paths.push(path.join(home, '.opencode', 'bin'));
    }
  } else {
    // Unix paths
    paths.push(
      '/usr/local/bin',
      '/opt/homebrew/bin',  // macOS ARM Homebrew
      '/usr/bin',
      '/bin',
    );

    const voltaHome = process.env.VOLTA_HOME;
    if (voltaHome) {
      paths.push(path.join(voltaHome, 'bin'));
    }

    const asdfRoot = process.env.ASDF_DATA_DIR || process.env.ASDF_DIR;
    if (asdfRoot) {
      paths.push(path.join(asdfRoot, 'shims'));
      paths.push(path.join(asdfRoot, 'bin'));
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
      paths.push(path.join(home, 'bin'));
      paths.push(path.join(home, '.local', 'bin'));
      paths.push(path.join(home, '.bun', 'bin'));
      paths.push(path.join(home, '.opencode', 'bin'));
      paths.push(path.join(home, '.docker', 'bin'));
      paths.push(path.join(home, '.npm-global', 'bin'));
      paths.push(path.join(home, '.volta', 'bin'));
      paths.push(path.join(home, '.asdf', 'shims'));
      paths.push(path.join(home, '.asdf', 'bin'));
      paths.push(path.join(home, '.fnm'));

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
  }

  const npmPrefix = process.env.npm_config_prefix;
  if (npmPrefix) {
    paths.push(isWindows ? npmPrefix : path.join(npmPrefix, 'bin'));
  }

  const miseShims = getMiseShimsDir(home);
  if (miseShims) paths.push(miseShims);
  paths.push(...getAppProvidedCLIPaths());

  return paths;
}

function* findNodeDirectories(additionalPaths?: string, searchPaths = getExtraBinaryPaths()): Generator<string, undefined> {
  const executables = new Set<string>();

  const currentPath = process.env.PATH || '';
  const pathDirs = parsePathEntries(currentPath);
  const additionalDirs = additionalPaths ? parsePathEntries(additionalPaths) : [];
  const allPaths = [...additionalDirs, ...searchPaths, ...pathDirs];

  for (const dir of allPaths) {
    if (!dir) continue;
    try {
      const nodePath = path.join(dir, NODE_EXECUTABLE);
      if (fs.existsSync(nodePath)) {
        const stat = fs.statSync(nodePath);
        if (stat.isFile() && !executables.has(nodePath)) {
          executables.add(nodePath);
          yield dir;
        }
      }
    } catch {
      // Inaccessible directory
    }
  }
}

export function findNodeExecutables(additionalPaths?: string): string[] {
  return [...findNodeDirectories(additionalPaths)].map(dir => path.join(dir, NODE_EXECUTABLE));
}

export function findNodeDirectory(additionalPaths?: string): string | null {
  return findNodeDirectories(additionalPaths).next().value ?? null;
}

export function findNodeExecutable(additionalPaths?: string): string | null {
  const nodeDir = findNodeDirectory(additionalPaths);
  return nodeDir ? path.join(nodeDir, NODE_EXECUTABLE) : null;
}

export function cliPathRequiresNode(cliPath: string): boolean {
  const jsExtensions = ['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx'];
  const lower = cliPath.toLowerCase();
  if (jsExtensions.some(ext => lower.endsWith(ext))) {
    return true;
  }

  try {
    let fd: number | null = null;
    try {
      fd = fs.openSync(cliPath, 'r');
      if (!fs.fstatSync(fd).isFile()) return false;
      const buffer = Buffer.alloc(200);
      const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, 0);
      const header = buffer.subarray(0, bytesRead).toString('utf8');
      if (!header.startsWith('#!')) return false;
      const shebangLine = header.split(/\r?\n/)[0].toLowerCase();
      return shebangLine.includes('node');
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

export function getEnhancedPath(additionalPaths?: string, cliPath?: string): string {
  const extraPaths = getExtraBinaryPaths().filter(p => p);
  const currentPath = process.env.PATH || '';

  const segments: string[] = [];

  if (additionalPaths) {
    segments.push(...parsePathEntries(additionalPaths));
  }

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

  if (cliPath && !cliDirHasNode && cliPathRequiresNode(cliPath)) {
    const nodeDir = findNodeDirectories(undefined, extraPaths).next().value;
    if (nodeDir) {
      segments.push(nodeDir);
    }
  }

  segments.push(...extraPaths);

  if (currentPath) {
    segments.push(...parsePathEntries(currentPath));
  }

  const seen = new Set<string>();
  const unique = segments.filter(p => {
    const normalized = isWindows ? p.toLowerCase() : p;
    if (seen.has(normalized)) return false;
    seen.add(normalized);
    return true;
  });

  return unique.join(PATH_SEPARATOR);
}

export function parseEnvironmentVariables(input: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of input.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const normalized = trimmed.startsWith('export ') ? trimmed.slice(7) : trimmed;
    const eqIndex = normalized.indexOf('=');
    if (eqIndex > 0) {
      const key = normalized.substring(0, eqIndex).trim();
      let value = normalized.substring(eqIndex + 1).trim();
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
