import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const OCTO_BINARY_NAME = process.platform === 'win32' ? 'octo.exe' : 'octo';

function getMacOSBundlePaths(): string[] {
  const paths: string[] = [];
  const applicationsDir = '/Applications';
  try {
    const entries = fs.readdirSync(applicationsDir);
    for (const entry of entries) {
      if (entry.toLowerCase().startsWith('octo') && entry.endsWith('.app')) {
        paths.push(path.join(applicationsDir, entry, 'Contents', 'MacOS'));
      }
    }
  } catch {
    // Ignore unreadable /Applications
  }
  return paths;
}

function getSearchDirectories(): string[] {
  const home = os.homedir();
  const dirs = [
    path.join(home, 'Library', 'Application Support', 'octo', 'bin'),
    path.join(home, '.local', 'bin'),
    '/usr/local/bin',
    '/opt/homebrew/bin',
    '/usr/bin',
    '/bin',
  ];

  if (process.platform === 'darwin') {
    dirs.unshift(...getMacOSBundlePaths());
  }

  return dirs;
}

export function resolveOctoAgentBinary(cliPath?: string): string | null {
  const candidates = [cliPath, OCTO_BINARY_NAME].filter(Boolean) as string[];
  const searchDirs = getSearchDirectories();

  for (const dir of searchDirs) {
    for (const candidate of candidates) {
      const fullPath = path.isAbsolute(candidate) ? candidate : path.join(dir, candidate);
      try {
        if (fs.existsSync(fullPath) && fs.statSync(fullPath).isFile()) {
          return fullPath;
        }
      } catch {
        // Ignore inaccessible paths
      }
    }
  }

  return null;
}
