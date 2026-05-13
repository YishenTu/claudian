import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';

import { extractResolvedAnswersFromResultText } from '../../../core/tools/toolInput';
import { isWriteEditTool, TOOL_ASK_USER_QUESTION } from '../../../core/tools/toolNames';
import type { ChatMessage, ContentBlock, ToolCallInfo } from '../../../core/types';
import { extractUserQuery } from '../../../utils/context';
import { extractDiffData } from '../../../utils/diff';
import {
  normalizeOpencodeToolInput,
  normalizeOpencodeToolName,
  normalizeOpencodeToolUseResult,
} from '../normalization/opencodeToolNormalization';
import { resolveExistingOpencodeDatabasePath } from '../runtime/OpencodePaths';
import type { OpencodeProviderState } from '../types';

type StoredRow = Record<string, unknown>;

interface StoredMessage {
  info: StoredRow;
  parts: StoredRow[];
}

interface SqliteModule {
  DatabaseSync: new (location: string, options?: Record<string, unknown>) => {
    close(): void;
    prepare(sql: string): {
      all(...params: unknown[]): StoredRow[];
    };
  };
}

export async function loadOpencodeSessionMessages(
  sessionId: string,
  providerState?: OpencodeProviderState,
): Promise<ChatMessage[]> {
  const databasePath = resolveExistingOpencodeDatabasePath(providerState?.databasePath);
  if (!databasePath || databasePath === ':memory:' || !fs.existsSync(databasePath)) {
    return [];
  }

  const rows = await loadOpencodeSessionRows(databasePath, sessionId);
  if (!rows) {
    return [];
  }

  return mapOpencodeMessages(
    hydrateStoredMessages(rows.messageRows, rows.partRows),
  );
}

export function mapOpencodeMessages(messages: StoredMessage[]): ChatMessage[] {
  return mergeAdjacentAssistantMessages(messages
    .map((message) => mapStoredMessage(message))
    .filter((message): message is ChatMessage => message !== null));
}

function hydrateStoredMessages(
  messageRows: StoredRow[],
  partRows: StoredRow[],
): StoredMessage[] {
  const partsByMessage = new Map<string, StoredRow[]>();

  for (const row of partRows) {
    const messageId = getString(row.message_id);
    const id = getString(row.id);
    const data = parseJsonObject(row.data);
    if (!messageId || !id || !data) {
      continue;
    }

    const parts = partsByMessage.get(messageId) ?? [];
    parts.push({ ...data, id });
    partsByMessage.set(messageId, parts);
  }

  return messageRows.flatMap((row) => {
    const id = getString(row.id);
    const data = parseJsonObject(row.data);
    if (!id || !data) {
      return [];
    }

    return [{
      info: { ...data, id, time_created: row.time_created },
      parts: partsByMessage.get(id) ?? [],
    }];
  });
}

function mapStoredMessage(message: StoredMessage): ChatMessage | null {
  const role = getString(message.info.role);
  const id = getString(message.info.id);
  if (!id || (role !== 'user' && role !== 'assistant')) {
    return null;
  }

  const createdAt = getNestedNumber(message.info, ['time', 'created'])
    ?? getNumber(message.info.time_created)
    ?? Date.now();

  if (role === 'user') {
    const promptText = extractUserQuery(getJoinedTextParts(message.parts));
    return {
      assistantMessageId: undefined,
      content: promptText,
      id,
      role: 'user',
      timestamp: createdAt,
      userMessageId: id,
    };
  }

  const contentBlocks = buildAssistantContentBlocks(message.parts);
  const toolCalls = buildAssistantToolCalls(message.parts);
  const completedAt = getNestedNumber(message.info, ['time', 'completed']);
  const durationSeconds = completedAt && completedAt >= createdAt
    ? Math.max(0, (completedAt - createdAt) / 1_000)
    : undefined;

  return {
    assistantMessageId: id,
    content: contentBlocks
      .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
      .map((block) => block.content)
      .join(''),
    contentBlocks: contentBlocks.length > 0 ? contentBlocks : undefined,
    durationSeconds,
    id,
    role: 'assistant',
    timestamp: createdAt,
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
  };
}

function mergeAdjacentAssistantMessages(messages: ChatMessage[]): ChatMessage[] {
  const merged: ChatMessage[] = [];

  for (const message of messages) {
    const previous = merged[merged.length - 1];
    if (
      message.role === 'assistant'
      && previous?.role === 'assistant'
      && !message.isInterrupt
      && !previous.isInterrupt
    ) {
      previous.content += message.content;
      previous.assistantMessageId = message.assistantMessageId ?? previous.assistantMessageId;
      previous.durationFlavorWord = message.durationFlavorWord ?? previous.durationFlavorWord;
      previous.durationSeconds = mergeAssistantDurationSeconds(previous, message);
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

function mergeAssistantDurationSeconds(
  first: ChatMessage,
  next: ChatMessage,
): number | undefined {
  const firstEnd = getMessageCompletionTime(first);
  const nextEnd = getMessageCompletionTime(next);
  if (firstEnd === null && nextEnd === null) {
    return undefined;
  }

  const end = Math.max(firstEnd ?? first.timestamp, nextEnd ?? next.timestamp);
  return Math.max(0, (end - first.timestamp) / 1_000);
}

function getMessageCompletionTime(message: ChatMessage): number | null {
  if (typeof message.durationSeconds !== 'number') {
    return null;
  }

  return message.timestamp + (message.durationSeconds * 1_000);
}

function buildAssistantContentBlocks(parts: StoredRow[]): ContentBlock[] {
  const blocks: ContentBlock[] = [];

  for (const part of parts) {
    switch (getString(part.type)) {
      case 'reasoning': {
        const text = getString(part.text)?.trim();
        if (!text) {
          break;
        }
        blocks.push({
          content: text,
          durationSeconds: getDurationSeconds(part),
          type: 'thinking',
        });
        break;
      }
      case 'text': {
        const text = getString(part.text);
        if (!text || getBoolean(part.ignored)) {
          break;
        }
        blocks.push({
          content: text,
          type: 'text',
        });
        break;
      }
      case 'tool': {
        const toolId = getString(part.callID);
        if (!toolId) {
          break;
        }
        blocks.push({
          toolId,
          type: 'tool_use',
        });
        break;
      }
    }
  }

  return blocks;
}

function buildAssistantToolCalls(parts: StoredRow[]): ToolCallInfo[] {
  return parts.flatMap((part) => {
    if (getString(part.type) !== 'tool') {
      return [];
    }

    const id = getString(part.callID);
    const rawName = getString(part.tool);
    const state = getObject(part.state);
    const status = mapToolStatus(getString(state?.status));
    if (!id || !rawName || !status) {
      return [];
    }

    const input = normalizeOpencodeToolInput(rawName, getObject(state?.input) ?? {});
    const name = normalizeOpencodeToolName(rawName);
    const result = getString(state?.output) ?? getString(state?.error) ?? undefined;
    const toolUseResult = normalizeOpencodeToolUseResult(rawName, input, {
      ...(result ? { output: result } : {}),
      ...(getObject(state?.metadata) ? { metadata: getObject(state?.metadata) } : {}),
    });

    const toolCall: ToolCallInfo = {
      id,
      input,
      name,
      result,
      status,
    };

    if (name === TOOL_ASK_USER_QUESTION) {
      toolCall.resolvedAnswers = toolUseResult?.answers as ToolCallInfo['resolvedAnswers']
        ?? extractResolvedAnswersFromResultText(result);
    }

    if (status === 'completed' && isWriteEditTool(name)) {
      const diffData = extractDiffData(toolUseResult, toolCall);
      if (diffData) {
        toolCall.diffData = diffData;
      }
    }

    return [toolCall];
  });
}

function getJoinedTextParts(parts: StoredRow[]): string {
  return parts
    .filter((part) => getString(part.type) === 'text' && !getBoolean(part.ignored))
    .map((part) => getString(part.text) ?? '')
    .join('');
}

function getDurationSeconds(part: StoredRow): number | undefined {
  const start = getNestedNumber(part, ['time', 'start']);
  const end = getNestedNumber(part, ['time', 'end']);
  if (start === null || end === null || end < start) {
    return undefined;
  }

  return Math.max(0, (end - start) / 1_000);
}

function mapToolStatus(status: string | null): ToolCallInfo['status'] | null {
  switch (status) {
    case 'pending':
    case 'running':
      return 'running';
    case 'completed':
      return 'completed';
    case 'error':
      return 'error';
    default:
      return null;
  }
}

function parseJsonObject(value: unknown): StoredRow | null {
  if (typeof value !== 'string') {
    return null;
  }

  try {
    const parsed = JSON.parse(value) as unknown;
    return isPlainObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function getBoolean(value: unknown): boolean {
  return value === true;
}

function getObject(value: unknown): StoredRow | null {
  return isPlainObject(value) ? value : null;
}

function getString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function getNumber(value: unknown): number | null {
  return typeof value === 'number' ? value : null;
}

function getNestedNumber(
  value: StoredRow,
  keys: string[],
): number | null {
  let current: unknown = value;
  for (const key of keys) {
    if (!isPlainObject(current)) {
      return null;
    }
    current = current[key];
  }
  return getNumber(current);
}

async function loadSqliteModule(): Promise<SqliteModule | null> {
  try {
    return await import('node:sqlite');
  } catch {
    return null;
  }
}

interface StoredSessionRows {
  messageRows: StoredRow[];
  partRows: StoredRow[];
}

async function loadOpencodeSessionRows(
  databasePath: string,
  sessionId: string,
): Promise<StoredSessionRows | null> {
  const viaNodeSqlite = await loadSessionRowsWithNodeSqlite(databasePath, sessionId);
  if (viaNodeSqlite) {
    return viaNodeSqlite;
  }

  return loadSessionRowsWithSqliteCli(databasePath, sessionId);
}

async function loadSessionRowsWithNodeSqlite(
  databasePath: string,
  sessionId: string,
): Promise<StoredSessionRows | null> {
  const sqlite = await loadSqliteModule();
  if (!sqlite) {
    return null;
  }

  let db: InstanceType<SqliteModule['DatabaseSync']> | null = null;
  try {
    db = new sqlite.DatabaseSync(databasePath, { readonly: true });
    const messageRows = db.prepare(
      'select id, time_created, data from message where session_id = ? order by time_created asc, id asc',
    ).all(sessionId);
    const partRows = db.prepare(
      'select id, message_id, data from part where session_id = ? order by message_id asc, id asc',
    ).all(sessionId);
    return { messageRows, partRows };
  } catch {
    return null;
  } finally {
    db?.close();
  }
}

function loadSessionRowsWithSqliteCli(
  databasePath: string,
  sessionId: string,
): StoredSessionRows | null {
  const escapedSessionId = escapeSqlLiteral(sessionId);
  const messageRows = runSqlite3JsonQuery(
    databasePath,
    `select id, time_created, data from message where session_id = '${escapedSessionId}' order by time_created asc, id asc;`,
  );
  const partRows = runSqlite3JsonQuery(
    databasePath,
    `select id, message_id, data from part where session_id = '${escapedSessionId}' order by message_id asc, id asc;`,
  );

  if (!messageRows || !partRows) {
    return null;
  }

  return { messageRows, partRows };
}

function runSqlite3JsonQuery(
  databasePath: string,
  sql: string,
): StoredRow[] | null {
  const result = spawnSync(
    'sqlite3',
    ['-json', databasePath, sql],
    {
      encoding: 'utf8',
    },
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
