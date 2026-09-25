import { type ChildProcess, spawn as defaultSpawn, type SpawnOptions } from 'node:child_process';

import { findNodeExecutables } from '../../../utils/env';

export type StoredRow = Record<string, unknown>;

export interface StoredSessionRows {
  nativeVersion?: 2;
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
  nativeVersion?: 1 | 2 | 'auto';
  environment?: NodeJS.ProcessEnv;
  findNodeExecutables?: () => string[];
  requireSqliteModule?: () => SqliteModule | null;
  spawn?: SpawnSqliteProcess;
}

export const OPENCODE_SQLITE_QUERY_MAX_BUFFER = 100 * 1024 * 1024;
export const OPENCODE_MESSAGE_ROW_SQL = buildOpencodeMessageRowsSQL('?');

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
  let nativeVersion = dependencies.nativeVersion ?? 1;
  if (nativeVersion === 'auto') {
    // v1.18 also creates an empty session_message scaffold; session_v2 identifies v2.
    const schema = await querySessionRows(databasePath, sessionId, dependencies,
      (id) => `SELECT name FROM sqlite_master WHERE name = 'session_v2' AND ${id} IS NOT NULL`,
      (id) => `SELECT 1 WHERE ${id} IS NULL`);
    nativeVersion = schema.messageRows.length > 0 ? 2 : 1;
  }
  if (nativeVersion === 2) {
    const rows = await querySessionRows(databasePath, sessionId, dependencies,
      (id) => `SELECT id, type, time_created, data FROM session_message WHERE session_id = ${id} ORDER BY seq ASC`,
      (id) => `SELECT 1 WHERE ${id} IS NULL`);
    return { ...rows, nativeVersion: 2 };
  }
  const rows = await querySessionRows(databasePath, sessionId, dependencies, buildOpencodeMessageRowsSQL, buildOpencodePartRowsSQL);
  // Usage metadata is optional. Preserve the existing row shape where it is absent.
  for (const row of rows.messageRows) {
    for (const key of ['parent_id', 'output_tokens', 'reasoning_tokens', 'finish', 'error']) {
      if (row[key] === null) delete row[key];
    }
  }
  return rows;
}

export interface OpencodeTurnSelector {
  userMessageId?: string | null;
  startedAt: number;
}

/** Select only the requested turn's scalar metadata, through the same SQLite fallbacks as replay. */
export async function loadOpencodeTurnRows(
  databasePath: string,
  sessionId: string,
  selector: OpencodeTurnSelector,
  dependencies: OpencodeSqliteReaderDependencies = {},
): Promise<StoredSessionRows> {
  let version = dependencies.nativeVersion ?? 'auto';
  if (version === 'auto') {
    const schema = await querySessionRows(databasePath, sessionId, dependencies,
      id => `SELECT name FROM sqlite_master WHERE name = 'session_v2' AND ${id} IS NOT NULL`,
      id => `SELECT 1 WHERE ${id} IS NULL`);
    version = schema.messageRows.length > 0 ? 2 : 1;
  }
  const rows = await querySessionRows(databasePath, sessionId, dependencies,
    id => buildTurnRowsSQL(id, selector, version === 2 ? 2 : 1),
    id => `SELECT 1 WHERE ${id} IS NULL`);
  return version === 2 ? { ...rows, nativeVersion: 2 } : rows;
}

function buildTurnRowsSQL(sessionId: string, selector: OpencodeTurnSelector, version: 1 | 2): string {
  const table = version === 2 ? 'session_message' : 'message';
  const userRole = version === 2 ? "type = 'user'" : "json_valid(data) AND json_extract(data, '$.role') = 'user'";
  const selectedUser = selector.userMessageId
    ? `id = '${escapeSQLLiteral(selector.userMessageId)}'`
    : `${userRole} AND time_created >= ${Number.isFinite(selector.startedAt) ? Math.floor(selector.startedAt) : 'NULL'}`;
  const order = version === 2 ? 'seq' : 'time_created, id';
  const columns = `id, session_id, time_created${version === 2 ? ', seq' : ''}`;
  const range = `(${order}) >= (SELECT ${order} FROM selected_user)
    AND (NOT EXISTS (SELECT 1 FROM next_user) OR (${order}) < (SELECT ${order} FROM next_user))`;
  return `WITH selected_user AS (
    SELECT ${columns} FROM ${table} WHERE session_id = ${sessionId} AND ${selectedUser}
    ORDER BY ${version === 2 ? 'seq' : 'time_created'} DESC, id DESC LIMIT 1
  ), next_user AS (
    SELECT ${columns} FROM ${table}
    WHERE session_id = (SELECT session_id FROM selected_user) AND ${userRole}
      AND (${order}) > (SELECT ${order} FROM selected_user)
    ORDER BY ${order} LIMIT 1
  ), turn_rows AS (
    SELECT *, json_valid(data) AS data_valid FROM ${table}
    WHERE session_id = (SELECT session_id FROM selected_user) AND ${range}
  )
  SELECT id, time_created, data_valid,
    ${version === 2 ? 'type' : "CASE WHEN data_valid THEN json_extract(data, '$.role') END"} AS role,
    CASE WHEN data_valid THEN json_extract(data, '$.time.created') END AS data_time_created,
    CASE WHEN data_valid THEN json_extract(data, '$.time.completed') END AS data_time_completed,
    CASE WHEN data_valid THEN json_extract(data, '$.parentID') END AS parent_id,
    CASE WHEN data_valid THEN json_extract(data, '$.tokens.output') END AS output_tokens,
    CASE WHEN data_valid THEN json_extract(data, '$.tokens.reasoning') END AS reasoning_tokens,
    CASE WHEN data_valid THEN json_extract(data, '$.finish') END AS finish,
    CASE WHEN data_valid THEN json_extract(data, '$.error') END AS error
  FROM turn_rows ORDER BY ${version === 2 ? 'seq' : 'time_created'}, id;`;
}

async function querySessionRows(
  databasePath: string,
  sessionId: string,
  dependencies: OpencodeSqliteReaderDependencies,
  messageSql: (id: string) => string,
  partSql: (id: string) => string,
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
        messageRows: db.prepare(messageSql('?')).all(sessionId),
        partRows: db.prepare(partSql('?')).all(sessionId),
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
        messageSql('?'),
        partSql('?'),
      ], spawn, environment);
      const rows = parseStoredSessionRows(stdout);
      if (!rows) throw new Error('Invalid SQLite query output.');
      return rows;
    } catch (error) {
      errors.push(`Node.js (${nodePath}): ${formatError(error)}`);
    }
  }

  try {
    const escapedSessionId = escapeSQLLiteral(sessionId);
    const messageRows = await runSqlite3JSONQuery(
      databasePath,
      messageSql(`'${escapedSessionId}'`),
      spawn,
      environment,
    );
    const partRows = await runSqlite3JSONQuery(
      databasePath,
      partSql(`'${escapedSessionId}'`),
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

async function runSqlite3JSONQuery(
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

function escapeSQLLiteral(value: string): string {
  return value.replaceAll('\'', '\'\'');
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function buildOpencodeMessageRowsSQL(sessionIdExpression: string): string {
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
  case when data_valid then json_extract(data, '$.time.completed') end as data_time_completed,
  case when data_valid then json_extract(data, '$.parentID') end as parent_id,
  case when data_valid then json_extract(data, '$.tokens.output') end as output_tokens,
  case when data_valid then json_extract(data, '$.tokens.reasoning') end as reasoning_tokens,
  case when data_valid then json_extract(data, '$.finish') end as finish,
  case when data_valid then json_extract(data, '$.error') end as error
from message_json
order by time_created asc, id asc;`.trim();
}

function buildOpencodePartRowsSQL(sessionIdExpression: string): string {
  return `
select id, message_id, data
from part
where session_id = ${sessionIdExpression}
order by message_id asc, id asc;`.trim();
}
