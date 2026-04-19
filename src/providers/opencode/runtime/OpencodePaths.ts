import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const OPENCODE_APP_NAME = 'opencode';
const DEFAULT_DATABASE_NAME = 'opencode.db';
const DATABASE_NAME_PATTERN = /^opencode(?:-[a-z0-9._-]+)?\.db$/i;

export function resolveOpencodeDataDir(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const xdgDataHome = env.XDG_DATA_HOME?.trim();
  if (xdgDataHome) {
    return path.join(xdgDataHome, OPENCODE_APP_NAME);
  }

  const home = env.HOME || os.homedir();
  if (process.platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', OPENCODE_APP_NAME);
  }

  if (process.platform === 'win32') {
    const appData = env.APPDATA || env.LOCALAPPDATA || path.join(home, 'AppData', 'Roaming');
    return path.join(appData, OPENCODE_APP_NAME);
  }

  return path.join(home, '.local', 'share', OPENCODE_APP_NAME);
}

export function resolveOpencodeDatabasePath(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const override = env.OPENCODE_DB?.trim();
  if (override) {
    if (override === ':memory:' || path.isAbsolute(override)) {
      return override;
    }
    return path.join(resolveOpencodeDataDir(env), override);
  }

  const dataDir = resolveOpencodeDataDir(env);
  const preferred = path.join(dataDir, DEFAULT_DATABASE_NAME);
  if (fs.existsSync(preferred)) {
    return preferred;
  }

  try {
    const matches = fs.readdirSync(dataDir)
      .filter((entry) => DATABASE_NAME_PATTERN.test(entry))
      .sort((left, right) => {
        if (left === DEFAULT_DATABASE_NAME) return -1;
        if (right === DEFAULT_DATABASE_NAME) return 1;
        return left.localeCompare(right);
      });

    if (matches.length > 0) {
      return path.join(dataDir, matches[0]!);
    }
  } catch {
    return preferred;
  }

  return preferred;
}
