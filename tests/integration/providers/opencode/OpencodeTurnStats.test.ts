import { mkdtempSync, rmSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { loadOpencodeTurnStats } from '@/providers/opencode/history/OpencodeTurnStats';

it.each([[1, undefined], [2, { outputTokens: 125, durationMs: 2500 }]] as const)('loads only the requested v%s native turn, including reasoning', async (version, statsWithoutParent) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'opencode-turn-'));
  const databasePath = path.join(root, 'opencode.db');
  const db = new DatabaseSync(databasePath);
  db.exec(version === 1
    ? 'CREATE TABLE message(id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT)'
    : 'CREATE TABLE session_message(id TEXT PRIMARY KEY, session_id TEXT, seq INTEGER, type TEXT, time_created INTEGER, data TEXT)');
  const records = [
    { id: 'old-u', role: 'user', time: { created: 100 } },
    { id: 'old-a', role: 'assistant', parentID: 'old-u', time: { created: 200, completed: 300 }, finish: 'stop', tokens: { output: 900, reasoning: 10 } },
    { id: 'u', role: 'user', time: { created: 1000 } },
    { id: 'a', role: 'assistant', parentID: 'u', time: { created: 1200, completed: 2000 }, finish: 'tool-calls', tokens: { output: 20, reasoning: 80 } },
    { id: 'final', role: 'assistant', parentID: 'u', time: { created: 2500, completed: 3500 }, finish: 'stop', tokens: { output: 10, reasoning: 15 } },
    { id: 'idle', role: 'idle', time: { created: 3600 } },
    { id: 'next-u', role: 'user', time: { created: 4000 } },
    { id: 'next-a', role: 'assistant', parentID: 'next-u', time: { created: 4200, completed: 4500 }, finish: 'stop', tokens: { output: 800, reasoning: 10 } },
  ];
  for (const [seq, record] of records.entries()) {
    if (version === 1) db.prepare('INSERT INTO message VALUES (?, ?, ?, ?)')
      .run(record.id, 'session', record.time.created, JSON.stringify(record));
    else db.prepare('INSERT INTO session_message VALUES (?, ?, ?, ?, ?, ?)')
      .run(record.id, 'session', seq, record.role, record.time.created, JSON.stringify(record));
  }
  db.close();
  try {
    await expect(loadOpencodeTurnStats('session', { databasePath, nativeVersion: version }, { userMessageId: 'u', startedAt: 999 }))
      .resolves.toEqual({ outputTokens: 125, durationMs: 2500 });
    await expect(loadOpencodeTurnStats('session', { databasePath, nativeVersion: version }, { startedAt: 4000 }))
      .resolves.toEqual({ outputTokens: 810, durationMs: 500 });
    await expect(loadOpencodeTurnStats('session', { databasePath, nativeVersion: version }, { startedAt: 5000 }))
      .resolves.toBeUndefined();
    const damaged = new DatabaseSync(databasePath);
    damaged.prepare(`UPDATE ${version === 1 ? 'message' : 'session_message'} SET data = json_remove(data, '$.parentID') WHERE id = 'a'`).run();
    damaged.close();
    await expect(loadOpencodeTurnStats('session', { databasePath, nativeVersion: version }, { userMessageId: 'u', startedAt: 999 }))
      .resolves.toEqual(statsWithoutParent);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
