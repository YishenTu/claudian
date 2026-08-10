import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  resolveExistingOpencodeDatabasePath,
  resolveOpencodeDatabasePath,
  resolveOpencodeDataDir,
} from '../../../../src/providers/opencode/runtime/OpencodePaths';

describe('OpencodePaths', () => {
  const originalPlatform = process.platform;

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform });
  });

  it('prefers XDG data directories for OpenCode data', () => {
    expect(resolveOpencodeDataDir({
      HOME: '/home/tester',
      XDG_DATA_HOME: '/tmp/xdg-data',
    } as NodeJS.ProcessEnv)).toBe('/tmp/xdg-data/opencode');
  });

  it('uses the home data directory on Windows even when AppData paths are available', () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    const home = path.join(os.tmpdir(), 'claudian-opencode-home');
    const env = {
      APPDATA: path.join(home, 'AppData', 'Roaming'),
      HOME: home,
      LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
    } as NodeJS.ProcessEnv;
    const expectedDataDir = path.join(home, '.local', 'share', 'opencode');

    expect(resolveOpencodeDataDir(env)).toBe(expectedDataDir);
    expect(resolveOpencodeDatabasePath(env)).toBe(path.join(expectedDataDir, 'opencode.db'));
  });

  it('preserves XDG_DATA_HOME and OPENCODE_DB precedence on Windows', () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    const xdgDataHome = path.join(os.tmpdir(), 'claudian-opencode-xdg');
    const absoluteDatabasePath = path.join(os.tmpdir(), 'claudian-opencode-custom.db');
    const env = {
      APPDATA: path.join(os.tmpdir(), 'claudian-opencode-appdata'),
      HOME: path.join(os.tmpdir(), 'claudian-opencode-home'),
      XDG_DATA_HOME: xdgDataHome,
    } as NodeJS.ProcessEnv;

    expect(resolveOpencodeDataDir(env)).toBe(path.join(xdgDataHome, 'opencode'));
    expect(resolveOpencodeDatabasePath({
      ...env,
      OPENCODE_DB: absoluteDatabasePath,
    })).toBe(absoluteDatabasePath);
    expect(resolveOpencodeDatabasePath({
      ...env,
      OPENCODE_DB: 'opencode-work.db',
    })).toBe(path.join(xdgDataHome, 'opencode', 'opencode-work.db'));
  });

  it('falls back to the existing resolved database when persisted metadata points at a missing path', () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'claudian-opencode-paths-'));
    const xdgDataHome = path.join(tmpRoot, 'xdg-data');
    const dbDir = path.join(xdgDataHome, 'opencode');
    const dbPath = path.join(dbDir, 'opencode.db');
    fs.mkdirSync(dbDir, { recursive: true });
    fs.writeFileSync(dbPath, '');

    const env = {
      HOME: path.join(tmpRoot, 'home'),
      XDG_DATA_HOME: xdgDataHome,
    } as NodeJS.ProcessEnv;

    expect(resolveOpencodeDatabasePath(env)).toBe(dbPath);
    expect(resolveExistingOpencodeDatabasePath('/missing/opencode.db', env)).toBe(dbPath);
  });
});
