import { spawn as defaultSpawn } from 'node:child_process';

import { findNodeExecutable } from '../../../utils/env';

export type StoredRow = Record<string, unknown>;

export interface StoredSessionRows {
  messageRows: StoredRow[];
  partRows: StoredRow[];
}

interface SqliteModule {
  DatabaseSync: new (location: string, options?: Record<string, unknown>) => {
    close(): void;
    prepare(sql: string): {
      all(...params: unknown[]): StoredRow[];
    };
  };
}

export interface OpencodeSqliteReaderDependencies {
  findNodeExecutable?: () => string | null;
  requireSqliteModule?: () => SqliteModule | null;
  spawn?: typeof defaultSpawn;
}

export const OPENCODE_SQLITE_QUERY_MAX_BUFFER = 100 * 1024 * 1024;
export const OPENCODE_MESSAGE_ROW_SQL = buildOpencodeMessageRowsSql('?');

const OPENCODE_PART_ROW_SQL = buildOpencodePartRowsSql('?');
const OPENCODE_SQLITE_CHILD_SCRIPT = `
const { DatabaseSync } = require('node:sqlite');
const [databasePath, sessionId, messageSql, partSql] = process.argv.slice(1);
let db;
try {
  db = new DatabaseSync(databasePath, { readonly: true });
  const messageRows = db.prepare(messageSql).all(sessionId);
  const partRows = db.prepare(partSql).all(sessionId);
  process.stdout.write(JSON.stringify({ messageRows, partRows }));
} finally {
  if (db) db.close();
}
`.trim();

export async function loadOpencodeSessionRows(
  databasePath: string,
  sessionId: string,
  dependencies: OpencodeSqliteReaderDependencies = {},
): Promise<StoredSessionRows | null> {
  const resolvedDependencies = resolveDependencies(dependencies);

  const viaCurrentProcess = loadSessionRowsWithCurrentProcessSqlite(
    databasePath,
    sessionId,
    resolvedDependencies.requireSqliteModule,
  );
  if (viaCurrentProcess) {
    return viaCurrentProcess;
  }

  const viaNodeProcess = await loadSessionRowsWithNodeProcess(
    databasePath,
    sessionId,
    resolvedDependencies.findNodeExecutable,
    resolvedDependencies.spawn,
  );
  if (viaNodeProcess) {
    return viaNodeProcess;
  }

  return loadSessionRowsWithSqliteCli(
    databasePath,
    sessionId,
    resolvedDependencies.spawn,
  );
}

function resolveDependencies(
  dependencies: OpencodeSqliteReaderDependencies,
): Required<OpencodeSqliteReaderDependencies> {
  return {
    findNodeExecutable,
    requireSqliteModule,
    spawn: defaultSpawn,
    ...dependencies,
  };
}

function requireSqliteModule(): SqliteModule | null {
  try {
    if (typeof module === 'undefined' || typeof module.require !== 'function') {
      return null;
    }

    const sqlite = module.require('node:sqlite') as unknown;
    return isSqliteModule(sqlite) ? sqlite : null;
  } catch {
    return null;
  }
}

function isSqliteModule(value: unknown): value is SqliteModule {
  return (
    isPlainObject(value)
    && typeof value.DatabaseSync === 'function'
  );
}

function loadSessionRowsWithCurrentProcessSqlite(
  databasePath: string,
  sessionId: string,
  requireSqlite: () => SqliteModule | null,
): StoredSessionRows | null {
  const sqlite = requireSqlite();
  if (!sqlite) {
    return null;
  }

  let db: InstanceType<SqliteModule['DatabaseSync']> | null = null;
  try {
    db = new sqlite.DatabaseSync(databasePath, { readonly: true });
    const messageRows = db.prepare(OPENCODE_MESSAGE_ROW_SQL).all(sessionId);
    const partRows = db.prepare(OPENCODE_PART_ROW_SQL).all(sessionId);
    return { messageRows, partRows };
  } catch {
    return null;
  } finally {
    db?.close();
  }
}

async function loadSessionRowsWithNodeProcess(
  databasePath: string,
  sessionId: string,
  findNode: () => string | null,
  spawn: typeof defaultSpawn,
): Promise<StoredSessionRows | null> {
  const nodePath = findNode();
  if (!nodePath) {
    return null;
  }

  const stdout = await runBufferedChild(
    nodePath,
    [
      '-e',
      OPENCODE_SQLITE_CHILD_SCRIPT,
      databasePath,
      sessionId,
      OPENCODE_MESSAGE_ROW_SQL,
      OPENCODE_PART_ROW_SQL,
    ],
    spawn,
  );
  return stdout === null ? null : parseStoredSessionRows(stdout);
}

async function loadSessionRowsWithSqliteCli(
  databasePath: string,
  sessionId: string,
  spawn: typeof defaultSpawn,
): Promise<StoredSessionRows | null> {
  const escapedSessionId = escapeSqlLiteral(sessionId);
  const messageRows = await runSqlite3JsonQuery(
    databasePath,
    buildOpencodeMessageRowsSql(`'${escapedSessionId}'`),
    spawn,
  );
  const partRows = await runSqlite3JsonQuery(
    databasePath,
    buildOpencodePartRowsSql(`'${escapedSessionId}'`),
    spawn,
  );

  if (!messageRows || !partRows) {
    return null;
  }

  return { messageRows, partRows };
}

async function runSqlite3JsonQuery(
  databasePath: string,
  sql: string,
  spawn: typeof defaultSpawn,
): Promise<StoredRow[] | null> {
  const stdout = await runBufferedChild(
    'sqlite3',
    ['-json', databasePath, sql],
    spawn,
  );
  return stdout === null ? null : parseStoredRows(stdout);
}

function runBufferedChild(
  command: string,
  args: string[],
  spawn: typeof defaultSpawn,
): Promise<string | null> {
  return new Promise((resolve) => {
    let settled = false;
    let size = 0;
    let timer: number | null = null;
    const chunks: Buffer[] = [];
    let child: ReturnType<typeof defaultSpawn>;
    try {
      child = spawn(command, args, {
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true,
      });
    } catch {
      resolve(null);
      return;
    }
    const finish = (value: string | null): void => {
      if (settled) return;
      settled = true;
      if (timer !== null) window.clearTimeout(timer);
      resolve(value);
    };

    child.stdout?.on('data', (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.length;
      if (size > OPENCODE_SQLITE_QUERY_MAX_BUFFER) {
        child.kill('SIGKILL');
        finish(null);
        return;
      }
      chunks.push(buffer);
    });
    child.once('error', () => finish(null));
    child.once('close', (code) => {
      finish(code === 0 ? Buffer.concat(chunks).toString('utf8') : null);
    });
    timer = window.setTimeout(() => {
      child.kill('SIGKILL');
      finish(null);
    }, 10_000);
  });
}

function parseStoredSessionRows(value: string): StoredSessionRows | null {
  try {
    const parsed = JSON.parse(value || '{}') as unknown;
    if (!isPlainObject(parsed)) {
      return null;
    }

    const messageRows = parseStoredRowsValue(parsed.messageRows);
    const partRows = parseStoredRowsValue(parsed.partRows);
    return messageRows && partRows ? { messageRows, partRows } : null;
  } catch {
    return null;
  }
}

function parseStoredRows(value: string): StoredRow[] | null {
  try {
    return parseStoredRowsValue(JSON.parse(value || '[]') as unknown);
  } catch {
    return null;
  }
}

function parseStoredRowsValue(value: unknown): StoredRow[] | null {
  return Array.isArray(value)
    ? value.filter((row): row is StoredRow => isPlainObject(row))
    : null;
}

function escapeSqlLiteral(value: string): string {
  return value.replaceAll('\'', '\'\'');
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function buildOpencodeMessageRowsSql(sessionIdExpression: string): string {
  return `
with message_json as (
  select
    id,
    time_created,
    data,
    json_valid(data) as data_valid
  from message
  where session_id = ${sessionIdExpression}
)
select
  id,
  time_created,
  data_valid,
  case when data_valid then json_extract(data, '$.role') end as role,
  case when data_valid then json_extract(data, '$.time.created') end as data_time_created,
  case when data_valid then json_extract(data, '$.time.completed') end as data_time_completed
from message_json
order by time_created asc, id asc;`.trim();
}

function buildOpencodePartRowsSql(sessionIdExpression: string): string {
  return `
select id, message_id, data
from part
where session_id = ${sessionIdExpression}
order by message_id asc, id asc;`.trim();
}
