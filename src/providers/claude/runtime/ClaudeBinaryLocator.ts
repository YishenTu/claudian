import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { findBinaryInDirectories, isExistingFile } from '@/core/process/cliBinaryLocator';
import { parsePathEntries } from '@/core/process/cliPath';
import { getEnhancedPath } from '@/core/process/env';

const CLAUDE_CODE_PACKAGE_SEGMENTS = ['node_modules', '@anthropic-ai', 'claude-code'];
const CLAUDE_CODE_NODE_ENTRYPOINTS = ['cli-wrapper.cjs', 'cli.js'];

function findClaudeCodeNodeEntrypoint(packageRoot: string): string | null {
  for (const entrypoint of CLAUDE_CODE_NODE_ENTRYPOINTS) {
    const candidate = path.join(packageRoot, entrypoint);
    if (isExistingFile(candidate)) {
      return candidate;
    }
  }

  return null;
}

function resolveClaudeCodeEntrypointNearPathEntry(entry: string, isWindows: boolean): string | null {
  const directCandidate = findClaudeCodeNodeEntrypoint(
    path.join(entry, ...CLAUDE_CODE_PACKAGE_SEGMENTS)
  );
  if (directCandidate) {
    return directCandidate;
  }

  const baseName = path.basename(entry).toLowerCase();
  if (baseName === 'bin') {
    const prefix = path.dirname(entry);
    const packageParent = isWindows ? prefix : path.join(prefix, 'lib');
    const candidate = findClaudeCodeNodeEntrypoint(
      path.join(packageParent, ...CLAUDE_CODE_PACKAGE_SEGMENTS)
    );
    if (candidate) {
      return candidate;
    }
  }

  return null;
}

function resolveClaudeCodeEntrypointFromPathEntries(entries: string[], isWindows: boolean): string | null {
  for (const entry of entries) {
    const candidate = resolveClaudeCodeEntrypointNearPathEntry(entry, isWindows);
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
    const unixCandidate = findBinaryInDirectories(entries, ['claude']);
    return unixCandidate;
  }

  // An extension-less `claude` on a Windows PATH entry is npm's POSIX sh shim, which
  // cannot be spawned directly. Skip it like the .cmd shim and fall through to the
  // Node-backed package entrypoint below.
  const exeCandidate = findBinaryInDirectories(entries, ['claude.exe']);
  if (exeCandidate) {
    return exeCandidate;
  }

  const packageEntrypoint = resolveClaudeCodeEntrypointFromPathEntries(entries, isWindows);
  if (packageEntrypoint) {
    return packageEntrypoint;
  }

  return null;
}

function getNpmGlobalPrefix(): string | null {
  if (process.env.npm_config_prefix) {
    return process.env.npm_config_prefix;
  }

  if (process.platform === 'win32') {
    const appDataNpm = process.env.APPDATA
      ? path.join(process.env.APPDATA, 'npm')
      : null;
    if (appDataNpm && fs.existsSync(appDataNpm)) {
      return appDataNpm;
    }
  }

  return null;
}

function addClaudeCodeEntrypointPaths(paths: string[], packageParent: string): void {
  const packageRoot = path.join(packageParent, ...CLAUDE_CODE_PACKAGE_SEGMENTS);
  for (const entrypoint of CLAUDE_CODE_NODE_ENTRYPOINTS) {
    paths.push(path.join(packageRoot, entrypoint));
  }
}

function getNpmClaudeCodeEntrypointPaths(): string[] {
  const homeDir = os.homedir();
  const isWindows = process.platform === 'win32';
  const entrypointPaths: string[] = [];

  if (isWindows) {
    addClaudeCodeEntrypointPaths(entrypointPaths, path.join(homeDir, 'AppData', 'Roaming', 'npm'));

    const npmPrefix = getNpmGlobalPrefix();
    if (npmPrefix) {
      addClaudeCodeEntrypointPaths(entrypointPaths, npmPrefix);
    }

    const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
    const programFilesX86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';

    addClaudeCodeEntrypointPaths(entrypointPaths, path.join(programFiles, 'nodejs', 'node_global'));
    addClaudeCodeEntrypointPaths(entrypointPaths, path.join(programFilesX86, 'nodejs', 'node_global'));
    addClaudeCodeEntrypointPaths(entrypointPaths, path.join('D:', 'Program Files', 'nodejs', 'node_global'));
  } else {
    addClaudeCodeEntrypointPaths(entrypointPaths, path.join(homeDir, '.npm-global', 'lib'));
    addClaudeCodeEntrypointPaths(entrypointPaths, '/usr/local/lib');
    addClaudeCodeEntrypointPaths(entrypointPaths, '/usr/lib');

    if (process.env.npm_config_prefix) {
      addClaudeCodeEntrypointPaths(entrypointPaths, path.join(process.env.npm_config_prefix, 'lib'));
    }
  }

  return entrypointPaths;
}

export function findClaudeBinaryPath(pathValue?: string): string | null {
  const homeDir = os.homedir();
  const isWindows = process.platform === 'win32';
  const customResolution = resolveClaudeFromPathEntries(parsePathEntries(pathValue), isWindows);
  if (customResolution) {
    return customResolution;
  }

  const nativeDirectories = [path.join(homeDir, '.claude', 'local')];
  if (isWindows) {
    nativeDirectories.push(
      path.join(homeDir, 'AppData', 'Local', 'Claude'),
      path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Claude'),
      path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Claude'),
    );
  }
  // Claude's native installer uses this directory; prefer it over system installs.
  nativeDirectories.push(path.join(homeDir, '.local', 'bin'));
  const nativePath = findBinaryInDirectories(nativeDirectories, [isWindows ? 'claude.exe' : 'claude']);
  if (nativePath) {
    return nativePath;
  }

  // Share PATH discovery with the other providers, while keeping Claude's SDK-safe
  // Windows launcher selection (.exe or a Node entrypoint, never a shell shim).
  const sharedResolution = resolveClaudeFromPathEntries(parsePathEntries(getEnhancedPath()), isWindows);
  if (sharedResolution) {
    return sharedResolution;
  }

  for (const entrypoint of getNpmClaudeCodeEntrypointPaths()) {
    if (isExistingFile(entrypoint)) {
      return entrypoint;
    }
  }

  return null;
}
