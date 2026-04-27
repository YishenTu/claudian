import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import type { ChatMessage, ToolCallInfo } from '../../../core/types';

export function cursorWorkspaceHash(absoluteVaultPath: string): string {
  return crypto.createHash('md5').update(absoluteVaultPath).digest('hex');
}

export function resolveCursorStoreDbPath(
  absoluteVaultPath: string,
  sessionId: string,
): string | null {
  const hash = cursorWorkspaceHash(absoluteVaultPath);
  const candidate = path.join(os.homedir(), '.cursor', 'chats', hash, sessionId, 'store.db');
  return fs.existsSync(candidate) ? candidate : null;
}

function isIdeBootstrapUser(content: string): boolean {
  return content.includes('<user_info>');
}

function parseAssistantBlob(record: Record<string, unknown>): { text: string; toolCalls: ToolCallInfo[] } {
  const content = record.content;
  if (typeof content === 'string') {
    return { text: content, toolCalls: [] };
  }
  if (!Array.isArray(content)) {
    return { text: '', toolCalls: [] };
  }

  let text = '';
  const toolCalls: ToolCallInfo[] = [];

  for (const block of content) {
    if (!block || typeof block !== 'object') {
      continue;
    }
    const b = block as Record<string, unknown>;
    if (b.type === 'redacted-reasoning') {
      continue;
    }
    if (b.type === 'text' && typeof b.text === 'string') {
      text += b.text;
    }
    if (b.type === 'tool-call') {
      const id = typeof b.toolCallId === 'string' ? b.toolCallId : '';
      const name = typeof b.toolName === 'string' ? b.toolName : 'tool';
      const args = b.args && typeof b.args === 'object' && !Array.isArray(b.args)
        ? b.args as Record<string, unknown>
        : {};
      if (id) {
        toolCalls.push({
          id,
          name,
          input: args,
          status: 'running',
        });
      }
    }
  }

  return { text, toolCalls };
}

function applyToolBlob(record: Record<string, unknown>, messages: ChatMessage[]): void {
  const content = record.content;
  if (!Array.isArray(content)) {
    return;
  }

  for (const block of content) {
    if (!block || typeof block !== 'object') {
      continue;
    }
    const b = block as Record<string, unknown>;
    if (b.type !== 'tool-result') {
      continue;
    }
    const toolCallId = typeof b.toolCallId === 'string' ? b.toolCallId : '';
    if (!toolCallId) {
      continue;
    }
    const result = b.result;
    const resultStr = typeof result === 'string' ? result : JSON.stringify(result);

    const assistant = [...messages].reverse().find(
      m => m.role === 'assistant' && m.toolCalls?.some(t => t.id === toolCallId),
    );
    if (!assistant?.toolCalls) {
      continue;
    }
    const tc = assistant.toolCalls.find(t => t.id === toolCallId);
    if (tc) {
      tc.result = resultStr;
      tc.status = 'completed';
    }
  }
}

function openCursorSqliteReadonly(dbPath: string):
  | { prepare: (sql: string) => { all: () => unknown[] } }
  | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/consistent-type-imports
    const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite');
    const db = new DatabaseSync(dbPath, { readOnly: true });
    return db;
  } catch {
    return null;
  }
}

export function loadCursorChatMessagesFromStore(dbPath: string): ChatMessage[] {
  const db = openCursorSqliteReadonly(dbPath);
  if (!db) {
    return [];
  }

  let rows: Array<{ rowid: number; id: string; data: Buffer | Uint8Array }>;
  try {
    const stmt = db.prepare('SELECT rowid, id, data FROM blobs ORDER BY rowid');
    rows = stmt.all() as Array<{ rowid: number; id: string; data: Buffer | Uint8Array }>;
  } catch {
    return [];
  }

  const messages: ChatMessage[] = [];

  for (const row of rows) {
    const buf = Buffer.isBuffer(row.data) ? row.data : Buffer.from(row.data);
    const raw = buf.toString('utf8');
    if (!raw.startsWith('{')) {
      continue;
    }

    let record: Record<string, unknown>;
    try {
      record = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      continue;
    }

    const role = record.role;
    if (role === 'system') {
      continue;
    }

    if (role === 'user') {
      const c = record.content;
      const text = typeof c === 'string' ? c : '';
      if (isIdeBootstrapUser(text)) {
        continue;
      }
      messages.push({
        id: `cursor-${row.id.slice(0, 12)}`,
        role: 'user',
        content: text,
        timestamp: Date.now(),
      });
      continue;
    }

    if (role === 'assistant') {
      const { text, toolCalls } = parseAssistantBlob(record);
      messages.push({
        id: `cursor-${row.id.slice(0, 12)}`,
        role: 'assistant',
        content: text,
        timestamp: Date.now(),
        toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      });
      continue;
    }

    if (role === 'tool') {
      applyToolBlob(record, messages);
    }
  }

  return messages;
}
