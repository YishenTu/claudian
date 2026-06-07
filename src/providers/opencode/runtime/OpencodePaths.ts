import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const OPENCODE_APP_NAME = 'opencode';
const DEFAULT_DATABASE_NAME = 'opencode.db';
const DATABASE_NAME_PATTERN = /^opencode(?:-[a-z0-9._-]+)?\.db$/i;

function joinForValue(base: string, ...segments: string[]): string {
  return base.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(base)
    ? path.posix.join(base, ...segments)
    : path.join(base, ...segments);
}

export function resolveOpencodeDataDir(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const xdgDataHome = env.XDG_DATA_HOME?.trim();
  if (xdgDataHome) {
    return joinForValue(xdgDataHome, OPENCODE_APP_NAME);
  }

  const home = env.HOME || os.homedir();
  if (process.platform === 'win32') {
    const appData = env.APPDATA || env.LOCALAPPDATA || joinForValue(home, 'AppData', 'Roaming');
    return joinForValue(appData, OPENCODE_APP_NAME);
  }

  return joinForValue(home, '.local', 'share', OPENCODE_APP_NAME);
}

export function resolveOpencodeDatabasePath(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const override = env.OPENCODE_DB?.trim();
  if (override) {
    if (override === ':memory:' || path.isAbsolute(override)) {
      return override;
    }
    return joinForValue(resolveOpencodeDataDir(env), override);
  }

  const candidates = getOpencodeDatabasePathCandidates(env);
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return candidates[0] ?? null;
}

export function resolveExistingOpencodeDatabasePath(
  preferredPath?: string | null,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const preferred = preferredPath?.trim();
  if (preferred) {
    if (preferred === ':memory:') {
      return preferred;
    }
    if (fs.existsSync(preferred)) {
      return preferred;
    }
  }

  const resolved = resolveOpencodeDatabasePath(env);
  if (resolved && (resolved === ':memory:' || fs.existsSync(resolved))) {
    return resolved;
  }

  return preferred ?? resolved;
}

function getOpencodeDatabasePathCandidates(
  env: NodeJS.ProcessEnv,
): string[] {
  const candidates: string[] = [];
  const seen = new Set<string>();
  const home = env.HOME || os.homedir();
  const dataDirs = [
    resolveOpencodeDataDir(env),
    joinForValue(home, 'Library', 'Application Support', OPENCODE_APP_NAME),
  ];

  for (const dataDir of dataDirs) {
    pushCandidate(candidates, seen, joinForValue(dataDir, DEFAULT_DATABASE_NAME));
    try {
      const matches = fs.readdirSync(dataDir)
        .filter((entry) => DATABASE_NAME_PATTERN.test(entry))
        .sort((left, right) => {
          if (left === DEFAULT_DATABASE_NAME) return -1;
          if (right === DEFAULT_DATABASE_NAME) return 1;
          return left.localeCompare(right);
        });

      for (const entry of matches) {
        pushCandidate(candidates, seen, joinForValue(dataDir, entry));
      }
    } catch {
      // Ignore missing dirs and unreadable locations.
    }
  }

  return candidates;
}

function pushCandidate(
  candidates: string[],
  seen: Set<string>,
  candidate: string,
): void {
  if (seen.has(candidate)) {
    return;
  }

  seen.add(candidate);
  candidates.push(candidate);
}
