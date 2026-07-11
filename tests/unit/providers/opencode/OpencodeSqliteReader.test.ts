import type { spawn as nodeSpawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { PassThrough } from 'node:stream';

import {
  loadOpencodeSessionRows,
  OPENCODE_MESSAGE_ROW_SQL,
} from '../../../../src/providers/opencode/history/OpencodeSqliteReader';

type Spawn = typeof nodeSpawn;

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
    const spawn = createSpawnMock([{
      status: 0,
      stdout: JSON.stringify({
        messageRows: [{ id: 'msg-user' }],
        partRows: [{ id: 'part-user' }],
      }),
    }]);

    await expect(loadOpencodeSessionRows('/tmp/opencode.db', 'ses-node', {
      findNodeExecutable: () => '/usr/local/bin/node',
      requireSqliteModule: () => null,
      spawn,
    })).resolves.toEqual({
      messageRows: [{ id: 'msg-user' }],
      partRows: [{ id: 'part-user' }],
    });

    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn).toHaveBeenCalledWith(
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
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true,
      }),
    );
  });

  it('keeps sqlite3 as a buffered compatibility fallback', async () => {
    const spawn = createSpawnMock([
      {
        status: 0,
        stdout: JSON.stringify([{ id: 'msg-user' }]),
      },
      {
        status: 0,
        stdout: JSON.stringify([{ id: 'part-user' }]),
      },
    ]);

    await expect(loadOpencodeSessionRows('/tmp/opencode.db', 'ses-with-quote\'s', {
      findNodeExecutable: () => null,
      requireSqliteModule: () => null,
      spawn,
    })).resolves.toEqual({
      messageRows: [{ id: 'msg-user' }],
      partRows: [{ id: 'part-user' }],
    });

    expect(spawn).toHaveBeenCalledTimes(2);
    expect(spawn).toHaveBeenNthCalledWith(
      1,
      'sqlite3',
      [
        '-json',
        '/tmp/opencode.db',
        expect.stringContaining("where session_id = 'ses-with-quote''s'"),
      ],
      expect.objectContaining({
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true,
      }),
    );
    expect(spawn).toHaveBeenNthCalledWith(
      2,
      'sqlite3',
      [
        '-json',
        '/tmp/opencode.db',
        expect.stringContaining("where session_id = 'ses-with-quote''s'"),
      ],
      expect.objectContaining({
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true,
      }),
    );
  });
});

function createSpawnMock(
  outputs: Array<{ status: number; stdout: string }>,
): Spawn {
  const mock = jest.fn(() => {
    const output = outputs.shift() ?? { status: 1, stdout: '' };
    const child = new EventEmitter() as any;
    child.stdout = new PassThrough();
    child.kill = jest.fn();
    setImmediate(() => {
      child.stdout.end(output.stdout);
      child.emit('close', output.status);
    });
    return child;
  });
  return mock as unknown as Spawn;
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
