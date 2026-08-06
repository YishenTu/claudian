import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { loadCursorSessionMessages } from '@/providers/cursor/history/CursorHistoryStore';

describe('CursorHistoryStore', () => {
  it('reads user and assistant messages from a Cursor ACP session store', async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'cursor-history-'));
    const sessionId = 'session-fixture';
    const sessionDir = path.join(home, '.cursor', 'acp-sessions', sessionId);
    await fs.mkdir(sessionDir, { recursive: true });
    const databasePath = path.join(sessionDir, 'store.db');
    const db = new DatabaseSync(databasePath);
    db.exec('CREATE TABLE blobs (id TEXT PRIMARY KEY, data BLOB)');
    db.prepare('INSERT INTO blobs (id, data) VALUES (?, ?)').run(
      'system',
      Buffer.from(JSON.stringify({ role: 'system', content: 'context' })),
    );
    db.prepare('INSERT INTO blobs (id, data) VALUES (?, ?)').run(
      'user',
      Buffer.from(JSON.stringify({
        content: [{ type: 'text', text: '<timestamp>Thursday, Aug 6, 2026, 6:31 PM (UTC+8)</timestamp>\\n<user_query>hello</user_query>' }],
        providerOptions: { cursor: { requestId: 'request-user' } },
        role: 'user',
      })),
    );
    db.prepare('INSERT INTO blobs (id, data) VALUES (?, ?)').run(
      'assistant',
      Buffer.from(JSON.stringify({
        content: [
          { type: 'reasoning', text: 'Thinking' },
          { type: 'text', text: 'Hello there' },
        ],
        role: 'assistant',
      })),
    );
    db.close();

    await expect(loadCursorSessionMessages(sessionId, {
      environment: { HOME: home },
    })).resolves.toEqual([
      expect.objectContaining({
        content: 'hello',
        id: 'request-user',
        role: 'user',
        userMessageId: 'request-user',
      }),
      expect.objectContaining({
        assistantMessageId: expect.any(String),
        content: 'Hello there',
        contentBlocks: [
          { content: 'Thinking', type: 'thinking' },
          { content: 'Hello there', type: 'text' },
        ],
        role: 'assistant',
      }),
    ]);
  });
});
