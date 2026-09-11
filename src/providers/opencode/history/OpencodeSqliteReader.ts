import { type ChildProcess, spawn as defaultSpawn, type SpawnOptions } from 'node:child_process';

import { findNodeExecutables } from '../../../utils/env';

export type StoredRow = Record<string, unknown>;

export interface StoredSessionRows {
  messageRows: StoredRow[];
  partRows: StoredRow[];
}

interface SqliteModule {
  DatabaseSync: new (location: string, options: { readOnly: boolean }) => {
    close(): void;
    prepare(sql: string): {
      all(...params: unknown[]): StoredRow[];
    };
  };
}

type SpawnSqliteProcess = (command: string, args: string[], options: SpawnOptions) => ChildProcess;

export interface OpencodeSqliteReaderDependencies {
  environment?: NodeJS.ProcessEnv;
  findNodeExecutables?: () => string[];
  requireSqliteModule?: () => SqliteModule | null;
  spawn?: SpawnSqliteProcess;
}

export const OPENCODE_SQLITE_QUERY_MAX_BUFFER = 100 * 1024 * 1024;
export const OPENCODE_MESSAGE_ROW_SQL = buildOpencodeMessageRowsSql('?');

const OPENCODE_PART_ROW_SQL = buildOpencodePartRowsSql('?');
const OPENCODE_SQLITE_CHILD_SCRIPT = `
const { DatabaseSync } = require('node:sqlite');
const [databasePath, sessionId, messageSql, partSql] = process.argv.slice(1);
let db;
try {
  db = new DatabaseSync(databasePath, { readOnly: true });
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
): Promise<StoredSessionRows> {
  const spawn = dependencies.spawn ?? defaultSpawn;
  const environment = dependencies.environment ?? process.env;
  const errors: string[] = [];
  try {
    const sqlite = (dependencies.requireSqliteModule ?? requireSqliteModule)();
    if (!sqlite) throw new Error('node:sqlite is unavailable.');
    const db = new sqlite.DatabaseSync(databasePath, { readOnly: true });
    try {
      return {
        messageRows: db.prepare(OPENCODE_MESSAGE_ROW_SQL).all(sessionId),
        partRows: db.prepare(OPENCODE_PART_ROW_SQL).all(sessionId),
      };
    } finally {
      db.close();
    }
  } catch (error) {
    errors.push(`Obsidian SQLite: ${formatError(error)}`);
  }

  const nodePaths = dependencies.findNodeExecutables?.() ?? findNodeExecutables(environment.PATH);
  if (nodePaths.length === 0) errors.push('Node.js: no executable found.');
  for (const nodePath of nodePaths) {
    try {
      const stdout = await runBufferedChild(nodePath, [
        '-e',
        OPENCODE_SQLITE_CHILD_SCRIPT,
        databasePath,
        sessionId,
        OPENCODE_MESSAGE_ROW_SQL,
        OPENCODE_PART_ROW_SQL,
      ], spawn, environment);
      const rows = parseStoredSessionRows(stdout);
      if (!rows) throw new Error('Invalid SQLite query output.');
      return rows;
    } catch (error) {
      errors.push(`Node.js (${nodePath}): ${formatError(error)}`);
    }
  }

  try {
    const escapedSessionId = escapeSqlLiteral(sessionId);
    const messageRows = await runSqlite3JsonQuery(
      databasePath,
      buildOpencodeMessageRowsSql(`'${escapedSessionId}'`),
      spawn,
      environment,
    );
    const partRows = await runSqlite3JsonQuery(
      databasePath,
      buildOpencodePartRowsSql(`'${escapedSessionId}'`),
      spawn,
      environment,
    );
    return { messageRows, partRows };
  } catch (error) {
    errors.push(`sqlite3: ${formatError(error)}`);
  }

  throw new Error([
    'Could not read OpenCode session rows from SQLite.',
    ...errors,
    'History requires working SQLite support in Obsidian, Node.js 22.13+ (or a newer supported release), or sqlite3.',
  ].join('\n'));
}

function requireSqliteModule(): SqliteModule | null {
  // Obsidian supplies require separately from its plain { exports } module object.
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- Load optional SQLite lazily through Obsidian's injected require.
  const sqlite = require('node:sqlite') as unknown;
  return isPlainObject(sqlite) && typeof sqlite.DatabaseSync === 'function'
    ? sqlite as unknown as SqliteModule
    : null;
}

async function runSqlite3JsonQuery(
  databasePath: string,
  sql: string,
  spawn: SpawnSqliteProcess,
  environment: NodeJS.ProcessEnv,
): Promise<StoredRow[]> {
  const stdout = await runBufferedChild(
    'sqlite3',
    ['-readonly', '-json', databasePath, sql],
    spawn,
    environment,
  );
  const rows = parseStoredRows(stdout);
  if (!rows) throw new Error('Invalid SQLite query output.');
  return rows;
}

function runBufferedChild(
  command: string,
  args: string[],
  spawn: SpawnSqliteProcess,
  environment: NodeJS.ProcessEnv,
): Promise<string> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let size = 0;
    let timer: number | null = null;
    const chunks: Buffer[] = [];
    let stderr = '';
    const child = spawn(command, args, {
      env: environment,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      if (timer !== null) window.clearTimeout(timer);
      if (error) reject(error);
      else resolve(Buffer.concat(chunks).toString('utf8'));
    };

    child.stdout?.on('data', (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.length;
      if (size > OPENCODE_SQLITE_QUERY_MAX_BUFFER) {
        child.kill('SIGKILL');
        finish(new Error('SQLite query output exceeded the size limit.'));
        return;
      }
      chunks.push(buffer);
    });
    child.stderr?.on('data', (chunk: Buffer | string) => {
      stderr = (stderr + chunk.toString()).slice(0, 2_000);
    });
    child.once('error', (error) => finish(error));
    child.once('close', (code) => {
      finish(code === 0 ? undefined : new Error(stderr.trim() || `Process exited with code ${code}.`));
    });
    timer = window.setTimeout(() => {
      child.kill('SIGKILL');
      finish(new Error('SQLite query timed out after 10 seconds.'));
    }, 10_000);
  });
}

function formatError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 2_000);
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
  case when data_valid then json_extract(data, '$.providerID') end as provider_id,
  case when data_valid then json_extract(data, '$.modelID') end as model_id,
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
