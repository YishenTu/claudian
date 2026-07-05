import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';

import type { ChatMessage } from '../../../core/types';

export interface GeminiSessionEntry {
  id: string;
  message: ChatMessage;
  timestamp: string;
}

export function getGeminiSessionDir(vaultPath: string): string {
  return path.join(vaultPath, '.claudian', 'sessions', 'gemini');
}

export function getGeminiSessionFile(vaultPath: string, sessionId: string): string {
  return path.join(getGeminiSessionDir(vaultPath), `${sessionId}.jsonl`);
}

export async function appendGeminiSessionMessage(
  vaultPath: string,
  sessionId: string,
  message: ChatMessage,
): Promise<void> {
  const sessionDir = getGeminiSessionDir(vaultPath);
  await fsp.mkdir(sessionDir, { recursive: true });

  const sessionFile = getGeminiSessionFile(vaultPath, sessionId);
  const entry: GeminiSessionEntry = {
    id: randomUUID(),
    message,
    timestamp: new Date().toISOString(),
  };

  await fsp.appendFile(sessionFile, JSON.stringify(entry) + '\n', 'utf-8');
}

export async function parseGeminiSessionContent(content: string): Promise<ChatMessage[]> {
  const messages: ChatMessage[] = [];
  for (const line of content.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line) as GeminiSessionEntry;
      if (entry.message) {
        messages.push(entry.message);
      }
    } catch {
      // ignore
    }
  }
  return messages;
}

export async function loadGeminiSessionMessages(
  vaultPath: string,
  sessionId: string,
): Promise<ChatMessage[]> {
  const sessionFile = getGeminiSessionFile(vaultPath, sessionId);
  try {
    const content = await fsp.readFile(sessionFile, 'utf-8');
    return parseGeminiSessionContent(content);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    throw error;
  }
}

export async function deleteGeminiSession(vaultPath: string, sessionId: string): Promise<void> {
  const sessionFile = getGeminiSessionFile(vaultPath, sessionId);
  try {
    await fsp.unlink(sessionFile);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }
}
