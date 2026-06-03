import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type { ChatMessage, ContentBlock, ToolCallInfo } from '../../../core/types';

type StoredRow = Record<string, unknown>;

const HERMES_MESSAGE_ROW_SQL = buildHermesMessageRowsSql('?');
const HERMES_SCHEMA_VERSION_SQL = 'SELECT schema_version FROM pragma_user_version;';
const HERMES_HYDRATION_DIAGNOSTIC_ID_PREFIX = 'hermes-hydration-error';
const HERMES_SUPPORTED_SCHEMA_VERSION = 11;

interface SqliteModule {
  DatabaseSync: new (location: string, options?: Record<string, unknown>) => {
    close(): void;
    prepare(sql: string): {
      all(...params: unknown[]): StoredRow[];
    };
  };
}

interface HermesHydrationDiagnosticContext {
  databasePath?: string;
  sessionId?: string;
}

export function resolveExistingHermesDatabasePath(): string | null {
  const home = os.homedir();
  const dbPath = path.join(home, '.hermes', 'state.db');
  if (fs.existsSync(dbPath)) {
    return dbPath;
  }

  return null;
}

export async function loadHermesSessionMessages(
  sessionId: string,
): Promise<ChatMessage[]> {
  const databasePath = resolveExistingHermesDatabasePath();
  if (!databasePath || !fs.existsSync(databasePath)) {
    return [];
  }

  const rows = await loadHermesSessionRows(databasePath, sessionId);
  if (!rows) {
    return [createHermesHydrationDiagnosticMessage({
      databasePath,
      reason: 'Could not read Hermes session rows from SQLite.',
      sessionId,
    })];
  }

  return mapHermesMessages(rows, { databasePath, sessionId });
}

export function mapHermesMessages(
  rows: StoredRow[],
  context: HermesHydrationDiagnosticContext = {},
): ChatMessage[] {
  const messages: ChatMessage[] = [];

  for (const row of rows) {
    try {
      const mapped = mapHermesMessageRow(row, context);
      if (mapped) {
        messages.push(mapped);
      }
    } catch (error) {
      messages.push(createHermesHydrationDiagnosticMessage({
        ...context,
        messageId: getString(row.id) ?? undefined,
        reason: formatUnknownError(error),
      }));
    }
  }

  return mergeAdjacentAssistantMessages(messages);
}

export function isHermesSessionHydrationDiagnosticMessage(message: ChatMessage): boolean {
  return message.id.startsWith(`${HERMES_HYDRATION_DIAGNOSTIC_ID_PREFIX}-session-`);
}

// ---------------------------------------------------------------------------
// Row-to-message mapping
// ---------------------------------------------------------------------------

function mapHermesMessageRow(
  row: StoredRow,
  context: HermesHydrationDiagnosticContext,
): ChatMessage | null {
  const id = getString(row.id);
  if (!id) {
    return null;
  }

  const role = getString(row.role);
  if (role === 'tool') {
    return null;
  }
  if (role !== 'user' && role !== 'assistant') {
    return null;
  }

  const timestamp = getNumber(row.timestamp) ?? Date.now();
  const rawContent = row.content;
  const content = resolveContentText(rawContent);
  const toolCalls = role === 'assistant'
    ? parseToolCalls(row.tool_calls)
    : undefined;

  if (role === 'user') {
    return {
      assistantMessageId: undefined,
      content,
      id,
      role: 'user',
      timestamp,
      userMessageId: id,
    };
  }

  const contentBlocks = buildAssistantContentBlocks(content, toolCalls);

  return {
    assistantMessageId: id,
    content,
    contentBlocks: contentBlocks.length > 0 ? contentBlocks : undefined,
    id,
    role: 'assistant',
    timestamp,
    toolCalls: toolCalls?.length ? toolCalls : undefined,
  };
}

function resolveContentText(raw: unknown): string {
  if (typeof raw === 'string') {
    return raw;
  }

  if (Array.isArray(raw)) {
    return raw
      .filter((part): part is Record<string, unknown> =>
        isPlainObject(part) && getString(part.type) === 'text',
      )
      .map((part) => getString(part.text) ?? '')
      .join('');
  }

  return '';
}

function parseToolCalls(raw: unknown): ToolCallInfo[] | undefined {
  if (!raw || typeof raw !== 'string') {
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }

  if (!Array.isArray(parsed)) {
    return undefined;
  }

  const calls: ToolCallInfo[] = [];
  for (const entry of parsed) {
    if (!isPlainObject(entry)) {
      continue;
    }

    const id = getString(entry.id) ?? getString(entry.tool_call_id);
    const name = getString(entry.name) ?? getString(entry.tool_name);
    if (!id || !name) {
      continue;
    }

    calls.push({
      id,
      input: isPlainObject(entry.input) ? entry.input as Record<string, unknown> : {},
      name,
      result: getString(entry.result) ?? undefined,
      status: mapToolStatus(getString(entry.status)),
    });
  }

  return calls.length > 0 ? calls : undefined;
}

function buildAssistantContentBlocks(
  textContent: string,
  toolCalls?: ToolCallInfo[],
): ContentBlock[] {
  const blocks: ContentBlock[] = [];

  if (textContent) {
    blocks.push({ content: textContent, type: 'text' });
  }

  if (toolCalls) {
    for (const tc of toolCalls) {
      blocks.push({ toolId: tc.id, type: 'tool_use' });
    }
  }

  return blocks;
}

function mapToolStatus(status: string | null): ToolCallInfo['status'] {
  switch (status) {
    case 'completed':
      return 'completed';
    case 'error':
      return 'error';
    default:
      return 'running';
  }
}

// ---------------------------------------------------------------------------
// Adjacent assistant message merging
// ---------------------------------------------------------------------------

function mergeAdjacentAssistantMessages(messages: ChatMessage[]): ChatMessage[] {
  const merged: ChatMessage[] = [];

  for (const message of messages) {
    const previous = merged[merged.length - 1];
    if (
      message.role === 'assistant'
      && previous?.role === 'assistant'
      && !message.isInterrupt
      && !previous.isInterrupt
      && !isHermesHydrationDiagnosticMessage(message)
      && !isHermesHydrationDiagnosticMessage(previous)
    ) {
      previous.content += message.content;
      previous.assistantMessageId = message.assistantMessageId ?? previous.assistantMessageId;
      previous.toolCalls = mergeOptionalArrays(previous.toolCalls, message.toolCalls);
      previous.contentBlocks = mergeOptionalArrays(previous.contentBlocks, message.contentBlocks);
      continue;
    }

    merged.push(message);
  }

  return merged;
}

function mergeOptionalArrays<T>(left?: T[], right?: T[]): T[] | undefined {
  if (!left?.length && !right?.length) {
    return undefined;
  }

  return [
    ...(left ?? []),
    ...(right ?? []),
  ];
}

// ---------------------------------------------------------------------------
// Diagnostic messages
// ---------------------------------------------------------------------------

function createHermesHydrationDiagnosticMessage(params: {
  databasePath?: string;
  messageId?: string;
  reason: string;
  sessionId?: string;
}): ChatMessage {
  const detailLines = [
    'Failed to hydrate Hermes session.',
    'provider: Hermes',
    ...(params.sessionId ? [`sessionId: ${params.sessionId}`] : []),
    ...(params.databasePath ? [`databasePath: ${params.databasePath}`] : []),
    ...(params.messageId ? [`messageId: ${params.messageId}`] : []),
    `reason: ${params.reason}`,
  ];
  const content = detailLines.join('\n');

  return {
    assistantMessageId: undefined,
    content,
    contentBlocks: [{ content, type: 'text' }],
    id: buildHermesHydrationDiagnosticId(params),
    role: 'assistant',
    timestamp: Date.now(),
  };
}

function buildHermesHydrationDiagnosticId(params: {
  messageId?: string;
  sessionId?: string;
}): string {
  const scope = params.messageId ? 'message' : 'session';
  const rawId = params.messageId ?? params.sessionId ?? String(Date.now());
  const safeId = rawId.replace(/[^a-zA-Z0-9._-]/g, '-').slice(0, 120) || String(Date.now());
  return `${HERMES_HYDRATION_DIAGNOSTIC_ID_PREFIX}-${scope}-${safeId}`;
}

function isHermesHydrationDiagnosticMessage(message: ChatMessage): boolean {
  return message.id.startsWith(HERMES_HYDRATION_DIAGNOSTIC_ID_PREFIX);
}

// ---------------------------------------------------------------------------
// SQLite access
// ---------------------------------------------------------------------------

async function loadSqliteModule(): Promise<SqliteModule | null> {
  try {
    return await import('node:sqlite');
  } catch {
    return null;
  }
}

async function loadHermesSessionRows(
  databasePath: string,
  sessionId: string,
): Promise<StoredRow[] | null> {
  const viaNodeSqlite = await loadSessionRowsWithNodeSqlite(databasePath, sessionId);
  if (viaNodeSqlite !== null) {
    return viaNodeSqlite;
  }

  return loadSessionRowsWithSqliteCli(databasePath, sessionId);
}

async function loadSessionRowsWithNodeSqlite(
  databasePath: string,
  sessionId: string,
): Promise<StoredRow[] | null> {
  const sqlite = await loadSqliteModule();
  if (!sqlite) {
    return null;
  }

  let db: InstanceType<SqliteModule['DatabaseSync']> | null = null;
  try {
    db = new sqlite.DatabaseSync(databasePath, { readonly: true });

    const versionRows = db.prepare(HERMES_SCHEMA_VERSION_SQL).all();
    const schemaVersion = versionRows.length > 0
      ? getNumber(versionRows[0].schema_version)
      : null;
    if (schemaVersion !== null && schemaVersion > HERMES_SUPPORTED_SCHEMA_VERSION) {
      return null;
    }

    return db.prepare(HERMES_MESSAGE_ROW_SQL).all(sessionId);
  } catch {
    return null;
  } finally {
    db?.close();
  }
}

function loadSessionRowsWithSqliteCli(
  databasePath: string,
  sessionId: string,
): StoredRow[] | null {
  const escapedSessionId = escapeSqlLiteral(sessionId);

  const versionResult = runSqlite3JsonQuery(
    databasePath,
    HERMES_SCHEMA_VERSION_SQL,
  );
  if (versionResult && versionResult.length > 0) {
    const schemaVersion = getNumber(versionResult[0].schema_version);
    if (schemaVersion !== null && schemaVersion > HERMES_SUPPORTED_SCHEMA_VERSION) {
      return null;
    }
  }

  return runSqlite3JsonQuery(
    databasePath,
    buildHermesMessageRowsSql(`'${escapedSessionId}'`),
  );
}

function runSqlite3JsonQuery(
  databasePath: string,
  sql: string,
): StoredRow[] | null {
  const result = spawnSync(
    'sqlite3',
    ['-json', databasePath, sql],
    { encoding: 'utf8' },
  );

  if (result.error || result.status !== 0) {
    return null;
  }

  try {
    const parsed = JSON.parse(result.stdout || '[]') as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((row): row is StoredRow => isPlainObject(row))
      : null;
  } catch {
    return null;
  }
}

function escapeSqlLiteral(value: string): string {
  return value.replaceAll('\'', '\'\'');
}

function buildHermesMessageRowsSql(sessionIdExpression: string): string {
  return `
select
  id,
  role,
  content,
  tool_calls,
  tool_name,
  tool_call_id,
  timestamp,
  token_count
from messages
where session_id = ${sessionIdExpression}
order by timestamp asc, id asc;`.trim();
}

// ---------------------------------------------------------------------------
// Generic helpers
// ---------------------------------------------------------------------------

function formatUnknownError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function getString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function getNumber(value: unknown): number | null {
  return typeof value === 'number' ? value : null;
}
