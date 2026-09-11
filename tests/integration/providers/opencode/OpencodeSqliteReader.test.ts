import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { build } from 'esbuild';

import type * as reader from '../../../../src/providers/opencode/history/OpencodeSqliteReader';

it('reads history with the require function supplied by the Obsidian plugin loader', async () => {
  const tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'claudian-opencode-loader-'));
  try {
    const databasePath = path.join(tmpRoot, 'opencode.db');
    const db = new DatabaseSync(databasePath);
    try {
      db.exec(`
        CREATE TABLE message(id TEXT, session_id TEXT, time_created INTEGER, data TEXT);
        CREATE TABLE part(id TEXT, session_id TEXT, message_id TEXT, data TEXT);
        INSERT INTO message VALUES('msg-1', 'ses-1', 1000, '{"role":"user"}');
        INSERT INTO part VALUES('part-1', 'ses-1', 'msg-1', '{"type":"text","text":"Hello"}');
      `);
    } finally {
      db.close();
    }

    const bundle = await build({
      entryPoints: [path.resolve(__dirname, '../../../../src/providers/opencode/history/OpencodeSqliteReader.ts')],
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
    })).resolves.toEqual({
      messageRows: [{
        id: 'msg-1',
        time_created: 1000,
        data_valid: 1,
        role: 'user',
        provider_id: null,
        model_id: null,
        data_time_created: null,
        data_time_completed: null,
      }],
      partRows: [{ id: 'part-1', message_id: 'msg-1', data: '{"type":"text","text":"Hello"}' }],
    });
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
});
