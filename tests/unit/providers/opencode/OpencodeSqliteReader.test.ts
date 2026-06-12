import type { spawnSync as nodeSpawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import {
  loadOpencodeSessionRows,
  OPENCODE_MESSAGE_ROW_SQL,
  OPENCODE_SQLITE_QUERY_MAX_BUFFER,
} from '../../../../src/providers/opencode/history/OpencodeSqliteReader';

type SpawnSync = typeof nodeSpawnSync;

describe('loadOpencodeSessionRows', () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'claudian-opencode-sqlite-reader-'));
  });

  afterEach(() => {
    rmSync(tmpRoot, { force: true, recursive: true });
    jest.restoreAllMocks();
  });

  it('loads rows through a Node child process when in-process SQLite is unavailable', async () => {
    const dbPath = createFixtureDatabase(tmpRoot);

    await expect(loadOpencodeSessionRows(dbPath, 'ses-child', {
      findNodeExecutable: () => process.execPath,
      requireSqliteModule: () => null,
    })).resolves.toEqual({
      messageRows: [{
        data_time_completed: null,
        data_time_created: 1_000,
        data_valid: 1,
        id: 'msg-user',
        role: 'user',
        time_created: 1_000,
      }],
      partRows: [{
        data: JSON.stringify({ text: 'Hello from child process.', type: 'text' }),
        id: 'part-user',
        message_id: 'msg-user',
      }],
    });
  });

  it('uses a discovered Node executable before the system sqlite3 fallback', async () => {
    const spawnSync = jest.fn().mockReturnValue({
      error: undefined,
      status: 0,
      stdout: JSON.stringify({
        messageRows: [{ id: 'msg-user' }],
        partRows: [{ id: 'part-user' }],
      }),
    });

    await expect(loadOpencodeSessionRows('/tmp/opencode.db', 'ses-node', {
      findNodeExecutable: () => '/usr/local/bin/node',
      requireSqliteModule: () => null,
      spawnSync: toSpawnSync(spawnSync),
    })).resolves.toEqual({
      messageRows: [{ id: 'msg-user' }],
      partRows: [{ id: 'part-user' }],
    });

    expect(spawnSync).toHaveBeenCalledTimes(1);
    expect(spawnSync).toHaveBeenCalledWith(
      '/usr/local/bin/node',
      [
        '-e',
        expect.stringContaining("require('node:sqlite')"),
        '/tmp/opencode.db',
        'ses-node',
        OPENCODE_MESSAGE_ROW_SQL,
        expect.stringContaining('from part'),
      ],
      expect.objectContaining({
        encoding: 'utf8',
        maxBuffer: OPENCODE_SQLITE_QUERY_MAX_BUFFER,
        windowsHide: true,
      }),
    );
  });

  it('keeps sqlite3 as a buffered compatibility fallback', async () => {
    const spawnSync = jest.fn()
      .mockReturnValueOnce({
        error: undefined,
        status: 0,
        stdout: JSON.stringify([{ id: 'msg-user' }]),
      })
      .mockReturnValueOnce({
        error: undefined,
        status: 0,
        stdout: JSON.stringify([{ id: 'part-user' }]),
      });

    await expect(loadOpencodeSessionRows('/tmp/opencode.db', 'ses-with-quote\'s', {
      findNodeExecutable: () => null,
      requireSqliteModule: () => null,
      spawnSync: toSpawnSync(spawnSync),
    })).resolves.toEqual({
      messageRows: [{ id: 'msg-user' }],
      partRows: [{ id: 'part-user' }],
    });

    expect(spawnSync).toHaveBeenCalledTimes(2);
    expect(spawnSync).toHaveBeenNthCalledWith(
      1,
      'sqlite3',
      [
        '-json',
        '/tmp/opencode.db',
        expect.stringContaining("where session_id = 'ses-with-quote''s'"),
      ],
      expect.objectContaining({
        encoding: 'utf8',
        maxBuffer: OPENCODE_SQLITE_QUERY_MAX_BUFFER,
        windowsHide: true,
      }),
    );
    expect(spawnSync).toHaveBeenNthCalledWith(
      2,
      'sqlite3',
      [
        '-json',
        '/tmp/opencode.db',
        expect.stringContaining("where session_id = 'ses-with-quote''s'"),
      ],
      expect.objectContaining({
        encoding: 'utf8',
        maxBuffer: OPENCODE_SQLITE_QUERY_MAX_BUFFER,
        windowsHide: true,
      }),
    );
  });
});

function toSpawnSync(mock: jest.Mock): SpawnSync {
  return mock as unknown as SpawnSync;
}

function createFixtureDatabase(tmpRoot: string): string {
  const dbPath = path.join(tmpRoot, 'opencode.db');
  const db = new DatabaseSync(dbPath);
  try {
    db.exec(`
      create table message (
        id text primary key,
        session_id text not null,
        time_created integer not null,
        data text not null
      );
      create table part (
        id text primary key,
        session_id text not null,
        message_id text not null,
        data text not null
      );
    `);

    db.prepare('insert into message (id, session_id, time_created, data) values (?, ?, ?, ?)').run(
      'msg-user',
      'ses-child',
      1_000,
      JSON.stringify({
        role: 'user',
        time: { created: 1_000 },
      }),
    );
    db.prepare('insert into part (id, session_id, message_id, data) values (?, ?, ?, ?)').run(
      'part-user',
      'ses-child',
      'msg-user',
      JSON.stringify({ text: 'Hello from child process.', type: 'text' }),
    );
  } finally {
    db.close();
  }

  return dbPath;
}
