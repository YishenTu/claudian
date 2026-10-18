import { spawn as nodeSpawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { PassThrough } from 'node:stream';

import {
  loadOpencodeSessionRows,
  type OpencodeSqliteReaderDependencies,
} from '@/providers/opencode/history/OpencodeSqliteReader';

type Spawn = NonNullable<OpencodeSqliteReaderDependencies['spawn']>;

describe('loadOpencodeSessionRows', () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'claudian-opencode-sqlite-reader-'));
  });

  afterEach(() => {
    rmSync(tmpRoot, { force: true, recursive: true });
    jest.restoreAllMocks();
  });

  it('never creates a missing history database through in-process SQLite', async () => {
    const dbPath = path.join(tmpRoot, 'missing.db');
    await loadOpencodeSessionRows(dbPath, 'ses-missing', {
      requireSqliteModule: () => ({ DatabaseSync }),
      findNodeExecutables: () => [],
      spawn: createSpawnMock([]),
    }).catch(() => undefined);
    expect(existsSync(dbPath)).toBe(false);
  });

  it('tries a compatible Node after an installed Node fails', async () => {
    const dbPath = createFixtureDatabase(tmpRoot);
    const nodeWithoutSqlite = path.join(tmpRoot, 'old-node');
    const spawn: Spawn = (command, args, options) => nodeSpawn(
      process.execPath,
      command === process.execPath ? args : ['--no-experimental-sqlite', ...args],
      options,
    );
    await expect(loadOpencodeSessionRows(dbPath, 'ses-child', {
      requireSqliteModule: () => null,
      findNodeExecutables: () => [nodeWithoutSqlite, process.execPath],
      spawn,
    })).resolves.toMatchObject([{ id: 'msg-user' }]);
  });

  it('reports backend errors when SQLite cannot read the database', async () => {
    const dbPath = path.join(tmpRoot, 'empty.db');
    new DatabaseSync(dbPath).close();
    const spawn: Spawn = (command, args, options) => nodeSpawn(
      command === 'sqlite3' ? path.join(tmpRoot, 'missing-sqlite3') : command,
      args,
      options,
    );
    await expect(loadOpencodeSessionRows(dbPath, 'ses-missing', {
      requireSqliteModule: () => null,
      findNodeExecutables: () => [process.execPath],
      spawn,
    })).rejects.toThrow('no such table: session_message');
  });

  it('uses the supplied environment for external SQLite readers', async () => {
    const dbPath = createFixtureDatabase(tmpRoot);
    const spawn: Spawn = (command, args, options) => nodeSpawn(
      command === 'sqlite3' ? path.join(tmpRoot, 'missing-sqlite3') : command,
      args,
      options,
    );
    await expect(loadOpencodeSessionRows(dbPath, 'ses-child', {
      environment: { ...process.env, NODE_OPTIONS: '--no-experimental-sqlite' },
      requireSqliteModule: () => null,
      findNodeExecutables: () => [process.execPath],
      spawn,
    })).rejects.toThrow('No such built-in module: node:sqlite');
  });

  it('loads rows through a Node child process when in-process SQLite is unavailable', async () => {
    const dbPath = createFixtureDatabase(tmpRoot);

    await expect(loadOpencodeSessionRows(dbPath, 'ses-child', {
      findNodeExecutables: () => [process.execPath],
      requireSqliteModule: () => null,
    })).resolves.toEqual([{
      data: JSON.stringify({ text: 'Hello from child process.', time: { created: 1_000 } }),
      id: 'msg-user',
      time_created: 1_000,
      type: 'user',
    }]);
  });

  it('uses a discovered Node executable before the system sqlite3 fallback', async () => {
    const spawn = createSpawnMock([{
      status: 0,
      stdout: JSON.stringify([{ id: 'msg-user' }]),
    }]);

    await expect(loadOpencodeSessionRows('/tmp/opencode.db', 'ses-node', {
      findNodeExecutables: () => ['/usr/local/bin/node'],
      requireSqliteModule: () => null,
      spawn,
    })).resolves.toEqual([{ id: 'msg-user' }]);

    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn).toHaveBeenCalledWith(
      '/usr/local/bin/node',
      [
        '-e',
        expect.stringContaining("require('node:sqlite')"),
        '/tmp/opencode.db',
        'ses-node',
        expect.stringContaining('FROM session_message WHERE session_id = ?'),
      ],
      expect.objectContaining({
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      }),
    );
  });

  it('keeps sqlite3 as a buffered compatibility fallback', async () => {
    const spawn = createSpawnMock([{
      status: 0,
      stdout: JSON.stringify([{ id: 'msg-user' }]),
    }]);

    await expect(loadOpencodeSessionRows('/tmp/opencode.db', 'ses-with-quote\'s', {
      findNodeExecutables: () => [],
      requireSqliteModule: () => null,
      spawn,
    })).resolves.toEqual([{ id: 'msg-user' }]);

    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn).toHaveBeenCalledWith(
      'sqlite3',
      [
        '-readonly',
        '-json',
        '/tmp/opencode.db',
        expect.stringContaining("WHERE session_id = 'ses-with-quote''s'"),
      ],
      expect.objectContaining({
        stdio: ['ignore', 'pipe', 'pipe'],
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
    db.exec('CREATE TABLE session_message(id TEXT, session_id TEXT, seq INTEGER, type TEXT, time_created INTEGER, data TEXT)');
    db.prepare('INSERT INTO session_message VALUES (?, ?, ?, ?, ?, ?)').run(
      'msg-user',
      'ses-child',
      1,
      'user',
      1_000,
      JSON.stringify({ text: 'Hello from child process.', time: { created: 1_000 } }),
    );
  } finally {
    db.close();
  }

  return dbPath;
}
