import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  resolveExistingOpencodeDatabasePath,
  resolveOpencodeDatabasePath,
  resolveOpencodeDataDir,
} from '../../../../src/providers/opencode/runtime/OpencodePaths';

describe('OpencodePaths', () => {
  it('prefers XDG data directories for OpenCode data', () => {
    expect(resolveOpencodeDataDir({
      HOME: '/home/tester',
      XDG_DATA_HOME: '/tmp/xdg-data',
    } as NodeJS.ProcessEnv)).toBe('/tmp/xdg-data/opencode');
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
