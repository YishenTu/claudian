import { type ChildProcess, spawn as defaultSpawn, type SpawnOptions } from 'node:child_process';

import { findNodeExecutables } from '@/core/process/env';

export type StoredRow = Record<string, unknown>;

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

const OPENCODE_SQLITE_CHILD_SCRIPT = `
const { DatabaseSync } = require('node:sqlite');
const [databasePath, sessionId, sql] = process.argv.slice(1);
let db;
try {
  db = new DatabaseSync(databasePath, { readOnly: true });
  process.stdout.write(JSON.stringify(db.prepare(sql).all(sessionId)));
} finally {
  if (db) db.close();
}
`.trim();

export async function loadOpencodeSessionRows(
  databasePath: string,
  sessionId: string,
  dependencies: OpencodeSqliteReaderDependencies = {},
): Promise<StoredRow[]> {
  return querySessionRows(databasePath, sessionId, dependencies,
    (id) => `SELECT id, type, time_created, data FROM session_message WHERE session_id = ${id} ORDER BY seq ASC`);
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
): Promise<StoredRow[]> {
  return querySessionRows(databasePath, sessionId, dependencies, id => buildTurnRowsSQL(id, selector));
}

function buildTurnRowsSQL(sessionId: string, selector: OpencodeTurnSelector): string {
  const selectedUser = selector.userMessageId
    ? `id = '${escapeSQLLiteral(selector.userMessageId)}'`
    : `type = 'user' AND time_created >= ${Number.isFinite(selector.startedAt) ? Math.floor(selector.startedAt) : 'NULL'}`;
  const range = `seq >= (SELECT seq FROM selected_user)
    AND (NOT EXISTS (SELECT 1 FROM next_user) OR seq < (SELECT seq FROM next_user))`;
  return `WITH selected_user AS (
    SELECT id, session_id, time_created, seq FROM session_message WHERE session_id = ${sessionId} AND ${selectedUser}
    ORDER BY seq DESC, id DESC LIMIT 1
  ), next_user AS (
    SELECT id, session_id, time_created, seq FROM session_message
    WHERE session_id = (SELECT session_id FROM selected_user) AND type = 'user'
      AND seq > (SELECT seq FROM selected_user)
    ORDER BY seq LIMIT 1
  ), turn_rows AS (
    SELECT *, json_valid(data) AS data_valid FROM session_message
    WHERE session_id = (SELECT session_id FROM selected_user) AND ${range}
  )
  SELECT id, time_created, data_valid, type AS role,
    CASE WHEN data_valid THEN json_extract(data, '$.time.created') END AS data_time_created,
    CASE WHEN data_valid THEN json_extract(data, '$.time.completed') END AS data_time_completed,
    CASE WHEN data_valid THEN json_extract(data, '$.tokens.output') END AS output_tokens,
    CASE WHEN data_valid THEN json_extract(data, '$.tokens.reasoning') END AS reasoning_tokens,
    CASE WHEN data_valid THEN json_extract(data, '$.finish') END AS finish,
    CASE WHEN data_valid THEN json_extract(data, '$.error') END AS error
  FROM turn_rows ORDER BY seq, id;`;
}

async function querySessionRows(
  databasePath: string,
  sessionId: string,
  dependencies: OpencodeSqliteReaderDependencies,
  sql: (id: string) => string,
): Promise<StoredRow[]> {
  const spawn = dependencies.spawn ?? defaultSpawn;
  const environment = dependencies.environment ?? process.env;
  const errors: string[] = [];
  try {
    const sqlite = (dependencies.requireSqliteModule ?? requireSqliteModule)();
    if (!sqlite) throw new Error('node:sqlite is unavailable.');
    const db = new sqlite.DatabaseSync(databasePath, { readOnly: true });
    try {
      return db.prepare(sql('?')).all(sessionId);
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
        sql('?'),
      ], spawn, environment);
      const rows = parseStoredRows(stdout);
      if (!rows) throw new Error('Invalid SQLite query output.');
      return rows;
    } catch (error) {
      errors.push(`Node.js (${nodePath}): ${formatError(error)}`);
    }
  }

  try {
    return await runSqlite3JSONQuery(
      databasePath,
      sql(`'${escapeSQLLiteral(sessionId)}'`),
      spawn,
      environment,
    );
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
