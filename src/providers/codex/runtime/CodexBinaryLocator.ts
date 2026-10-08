import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { findBinaryInDirectories, findCLIBinaryPath, isExistingFile, parseCLIPathEntries } from '@/core/process/cliBinaryLocator';
import { stripSurroundingQuotes } from '@/core/process/cliPath';
import { expandHomePath } from '@/utils/path';

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
  const binaryNames = platform === 'win32'
    ? ['codex.exe', 'codex.cmd', 'codex']
    : ['codex'];
  const explicitPathBinary = findBinaryInDirectories(
    parseCLIPathEntries(additionalPath, platform),
    binaryNames,
  );
  if (explicitPathBinary) {
    return explicitPathBinary;
  }

  if (platform === 'win32') {
    const configuredInstallDir = process.env.CODEX_INSTALL_DIR?.trim();
    if (configuredInstallDir) {
      const dir = expandHomePath(stripSurroundingQuotes(configuredInstallDir));
      if (isCompleteWindowsCodexRuntimeDir(dir)) {
        return path.join(dir, 'codex.exe');
      }
    }
  }

  // Honor the inherited PATH before adding automatically discovered installations.
  const inheritedPathBinary = findBinaryInDirectories(
    parseCLIPathEntries(process.env.PATH, platform),
    binaryNames,
  );
  if (inheritedPathBinary) {
    return inheritedPathBinary;
  }

  const preferredBinary = findBinaryInDirectories(
    getPreferredCodexBinaryDirs(platform),
    binaryNames,
  );
  if (preferredBinary) {
    return preferredBinary;
  }

  return findCLIBinaryPath('codex', additionalPath, platform);
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
      path.join(home, 'Applications', 'ChatGPT.app', 'Contents', 'Resources', 'codex-cli', 'CodexCLI.app', 'Contents', 'MacOS'),
      '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS',
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

export function resolveCodexWSLCLIPath(
  hostnamePath: string | undefined,
  legacyPath: string | undefined,
): string {
  const configuredCommand = [hostnamePath, legacyPath]
    .map(value => stripSurroundingQuotes((value ?? '').trim()))
    .find(value => value.length > 0 && !isWindowsStyleCLIReference(value));
  return configuredCommand || 'codex';
}
