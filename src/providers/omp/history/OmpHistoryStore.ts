import * as fs from 'node:fs';
import * as path from 'node:path';

import type { ChatMessage, ContentBlock } from '../../../core/types';

export function parseOmpSessionContent(content: string): ChatMessage[] {
  const messages: ChatMessage[] = [];
  for (const line of content.split(/\r?\n/u)) {
    if (!line.trim()) continue;
    let entry: Record<string, unknown>;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (!isRecord(parsed)) continue;
      entry = parsed;
    } catch {
      continue;
    }
    if (entry.type !== 'message' || !isRecord(entry.message)) continue;
    const message = entry.message;
    const role = typeof message.role === 'string' ? message.role : '';
    const id = typeof entry.id === 'string' ? entry.id : `omp-${messages.length}`;
    const timestamp = getTimestamp(message.timestamp ?? entry.timestamp);
    if (role === 'user') {
      messages.push({
        content: getText(message.content),
        id,
        role: 'user',
        timestamp,
        userMessageId: id,
      });
      continue;
    }
    if (role === 'assistant') {
      const contentBlocks = getAssistantContentBlocks(message.content);
      messages.push({
        assistantMessageId: id,
        content: contentBlocks
          .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
          .map(block => block.content)
          .join(''),
        ...(contentBlocks.length > 0 ? { contentBlocks } : {}),
        id,
        role: 'assistant',
        timestamp,
      });
    }
  }
  return messages;
}

export function findOmpSessionFileInRoot(sessionId: string, root: string): string | null {
  const trimmed = sessionId.trim();
  if (!trimmed || /[\\/]/u.test(trimmed)) return null;
  return findRecursively(root, trimmed);
}

function findRecursively(root: string, sessionId: string): string | null {
  try {
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      const candidate = path.join(root, entry.name);
      if (entry.isDirectory()) {
        const found = findRecursively(candidate, sessionId);
        if (found) return found;
      } else if (entry.isFile() && entry.name.endsWith('.jsonl') && entry.name.includes(sessionId)) {
        return candidate;
      }
    }
  } catch {
    return null;
  }
  return null;
}

function getAssistantContentBlocks(value: unknown): ContentBlock[] {
  const parts = Array.isArray(value) ? value : [];
  const blocks: ContentBlock[] = [];
  for (const part of parts) {
    if (!isRecord(part)) continue;
    if (part.type === 'thinking') {
      const content = getText(part.thinking ?? part.text ?? part.content);
      if (content) blocks.push({ content, type: 'thinking' });
    } else if (part.type === 'text') {
      const content = getText(part.text ?? part.content);
      if (content) blocks.push({ content, type: 'text' });
    }
  }
  return blocks;
}

function getText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(getText).join('');
  if (!isRecord(value)) return '';
  return typeof value.text === 'string'
    ? value.text
    : typeof value.content === 'string'
      ? value.content
      : '';
}

function getTimestamp(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const timestamp = Date.parse(value);
    if (!Number.isNaN(timestamp)) return timestamp;
  }
  return Date.now();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
