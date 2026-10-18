import { mkdtempSync, rmSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { testDate } from '@test/helpers/testClock';

import * as sqliteReader from '@/providers/opencode/history/OpencodeSqliteReader';
import { loadOpencodeTurnStats } from '@/providers/opencode/history/OpencodeTurnStats';

it('skips optional statistics when the database does not exist', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'opencode-turn-missing-'));
  const databasePath = path.join(root, 'opencode.db');
  const loadRows = jest.spyOn(sqliteReader, 'loadOpencodeTurnRows');
  try {
    await expect(loadOpencodeTurnStats(
      'session', { databasePath }, { startedAt: testDate().getTime() }, { OPENCODE_DB: databasePath },
    )).resolves.toBeUndefined();
    expect(loadRows).not.toHaveBeenCalled();
  } finally {
    loadRows.mockRestore();
    rmSync(root, { recursive: true, force: true });
  }
});

it('loads only the requested native turn, including reasoning', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'opencode-turn-'));
  const databasePath = path.join(root, 'opencode.db');
  const db = new DatabaseSync(databasePath);
  db.exec('CREATE TABLE session_message(id TEXT PRIMARY KEY, session_id TEXT, seq INTEGER, type TEXT, time_created INTEGER, data TEXT)');
  const records = [
    { id: 'old-u', role: 'user', time: { created: 100 } },
    { id: 'old-a', role: 'assistant', time: { created: 200, completed: 300 }, finish: 'stop', tokens: { output: 900, reasoning: 10 } },
    { id: 'u', role: 'user', time: { created: 1000 } },
    { id: 'a', role: 'assistant', time: { created: 1200, completed: 2000 }, finish: 'tool-calls', tokens: { output: 20, reasoning: 80 } },
    { id: 'final', role: 'assistant', time: { created: 2500, completed: 3500 }, finish: 'stop', tokens: { output: 10, reasoning: 15 } },
    { id: 'idle', role: 'idle', time: { created: 3600 } },
    { id: 'next-u', role: 'user', time: { created: 4000 } },
    { id: 'next-a', role: 'assistant', time: { created: 4200, completed: 4500 }, finish: 'stop', tokens: { output: 800, reasoning: 10 } },
  ];
  for (const [seq, record] of records.entries()) {
    db.prepare('INSERT INTO session_message VALUES (?, ?, ?, ?, ?, ?)')
      .run(record.id, 'session', seq, record.role, record.time.created, JSON.stringify(record));
  }
  db.close();
  try {
    await expect(loadOpencodeTurnStats('session', { databasePath, nativeVersion: 2 }, { userMessageId: 'u', startedAt: 999 }))
      .resolves.toEqual({ outputTokens: 125, durationMs: 2500 });
    await expect(loadOpencodeTurnStats('session', { databasePath, nativeVersion: 2 }, { startedAt: 4000 }))
      .resolves.toEqual({ outputTokens: 810, durationMs: 500 });
    await expect(loadOpencodeTurnStats('session', { databasePath, nativeVersion: 2 }, { startedAt: 5000 }))
      .resolves.toBeUndefined();
    const damaged = new DatabaseSync(databasePath);
    damaged.prepare("UPDATE session_message SET data = json_remove(data, '$.tokens.reasoning') WHERE id = 'a'").run();
    damaged.close();
    await expect(loadOpencodeTurnStats('session', { databasePath, nativeVersion: 2 }, { userMessageId: 'u', startedAt: 999 }))
      .resolves.toBeUndefined();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
