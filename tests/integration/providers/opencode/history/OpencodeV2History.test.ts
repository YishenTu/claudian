import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { loadOpencodeSessionMessages, loadOpencodeSessionModel } from '@/providers/opencode/history/OpencodeHistoryStore';
import { loadOpencodeSessionRows } from '@/providers/opencode/history/OpencodeSqliteReader';

it('reads current v2 history in native sequence without replaying the retained v1 copy', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'opencode-v2-history-'));
  const databasePath = path.join(root, 'opencode.db');
  const db = new DatabaseSync(databasePath);
  try {
    db.exec(`
      CREATE TABLE message(id TEXT, session_id TEXT, time_created INTEGER, data TEXT);
      CREATE TABLE part(id TEXT, session_id TEXT, message_id TEXT, data TEXT);
      INSERT INTO message VALUES('legacy', 'session', 1, '{"role":"user"}');
      INSERT INTO part VALUES('part', 'session', 'legacy', '{"type":"text","text":"Stale v1"}');
      CREATE TABLE session_v2(id TEXT);
      CREATE TABLE session_message(id TEXT, session_id TEXT, seq INTEGER, type TEXT, time_created INTEGER, data TEXT);
    `);
    const insert = db.prepare('INSERT INTO session_message VALUES(?, ?, ?, ?, ?, ?)');
    const add = (id: string, seq: number, type: string, data: object) => {
      insert.run(id, 'session', seq, type, 1000, JSON.stringify(data));
    };
    add('z-user', 1, 'user', { text: 'Current prompt', time: { created: 1000 } });
    add('a-assistant', 2, 'assistant', {
      model: { providerID: 'test', id: 'first' }, time: { created: 2000, completed: 5000 },
      content: [
        { type: 'reasoning', text: 'Think', time: { created: 2000, completed: 3000 } },
        { type: 'tool', id: 'call-shell', name: 'shell', state: {
          status: 'completed', input: { command: 'pwd' },
          content: [{ type: 'text', text: '/vault' }, { type: 'file', uri: 'file:///vault/report.txt', mime: 'text/plain' }],
        } },
        { type: 'text', text: 'Done' },
      ],
    });
    add('idle', 3, 'idle', { time: { created: 5000 } });
    add('b-assistant', 4, 'assistant', { time: { created: 6000 }, content: [{ type: 'text', text: 'Separate turn' }] });
    add('model', 5, 'model-switched', { model: { providerID: 'test', id: 'second' }, time: { created: 7000 } });
    db.close();

    const messages = await loadOpencodeSessionMessages('session', { databasePath });
    expect(messages.map(({ content }) => content)).toEqual(['Current prompt', 'Done', 'Separate turn']);
    expect(messages[1]).toMatchObject({
      durationSeconds: 3,
      contentBlocks: [{ type: 'thinking', content: 'Think', durationSeconds: 1 }, { type: 'tool_use', toolId: 'call-shell' }, { type: 'text', content: 'Done' }],
      toolCalls: [{ name: 'Bash', input: { command: 'pwd' }, status: 'completed', result: '/vault', providerPayload: {
        rawOutput: { content: [{ type: 'text', text: '/vault' }, { type: 'file', uri: 'file:///vault/report.txt', mime: 'text/plain' }] },
      } }],
    });
    await expect(loadOpencodeSessionModel('session', { databasePath })).resolves.toBe('opencode:test/second');
    await expect(loadOpencodeSessionMessages('session', { databasePath, nativeVersion: 1 }))
      .resolves.toMatchObject([{ content: 'Current prompt' }, { content: 'Done' }, { content: 'Separate turn' }]);
    await expect(loadOpencodeSessionMessages('missing', { databasePath, nativeVersion: 2 })).resolves.toEqual([]);
    const childRows = await loadOpencodeSessionRows(databasePath, 'session', {
      nativeVersion: 2, requireSqliteModule: () => null, findNodeExecutables: () => [process.execPath],
    });
    expect(childRows.messageRows.map(({ id }) => id)).toEqual(['z-user', 'a-assistant', 'idle', 'b-assistant', 'model']);
  } finally {
    if (db.isOpen) db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

it('reads v1 history when its database already contains the empty future message table', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'opencode-v1-history-'));
  const databasePath = path.join(root, 'opencode.db');
  const db = new DatabaseSync(databasePath);
  try {
    db.exec(`
      CREATE TABLE message(id TEXT, session_id TEXT, time_created INTEGER, data TEXT);
      CREATE TABLE part(id TEXT, session_id TEXT, message_id TEXT, data TEXT);
      CREATE TABLE session_message(id TEXT, session_id TEXT, seq INTEGER, type TEXT, time_created INTEGER, data TEXT);
      INSERT INTO message VALUES('user', 'session', 1, '{"role":"user"}');
      INSERT INTO part VALUES('part', 'session', 'user', '{"type":"text","text":"Current v1 prompt"}');
    `);
    db.close();
    await expect(loadOpencodeSessionMessages('session', { databasePath, nativeVersion: 1 }))
      .resolves.toMatchObject([{ content: 'Current v1 prompt' }]);
  } finally {
    if (db.isOpen) db.close();
    rmSync(root, { recursive: true, force: true });
  }
});
