import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { build } from 'esbuild';

import type * as reader from '@/providers/opencode/history/OpencodeSqliteReader';

it('reads history with the require function supplied by the Obsidian plugin loader', async () => {
  const tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'claudian-opencode-loader-'));
  try {
    const databasePath = path.join(tmpRoot, 'opencode.db');
    const db = new DatabaseSync(databasePath);
    try {
      db.exec(`
        CREATE TABLE session_message(id TEXT, session_id TEXT, seq INTEGER, type TEXT, time_created INTEGER, data TEXT);
        INSERT INTO session_message VALUES('msg-1', 'ses-1', 1, 'user', 1000, '{"text":"Hello"}');
      `);
    } finally {
      db.close();
    }

    const bundle = await build({
      entryPoints: [path.resolve(__dirname, '../../../../../src/providers/opencode/history/OpencodeSqliteReader.ts')],
      bundle: true,
      platform: 'node',
      format: 'cjs',
      write: false,
    });
    // Obsidian supplies require separately and gives plugins only { exports } as module.
    const pluginModule = { exports: {} as typeof reader };
    Function('require', 'module', 'exports', bundle.outputFiles[0].text)(
      createRequire(__filename), pluginModule, pluginModule.exports,
    );

    await expect(pluginModule.exports.loadOpencodeSessionRows(databasePath, 'ses-1', {
      findNodeExecutables: () => [],
      spawn: () => { throw new Error('No external SQLite reader installed.'); },
    })).resolves.toEqual([{ id: 'msg-1', type: 'user', time_created: 1000, data: '{"text":"Hello"}' }]);
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
});
