import * as fs from 'fs';

import type {
  ProviderConversationHistoryService,
  ProviderHistoryPathContext,
} from '../../../core/providers/types';
import type { ChatMessage, Conversation } from '../../../core/types';
import { getGrokState, type GrokProviderState, resolveGrokSessionId } from '../types';
import { resolveGrokHistoryFile, resolveGrokHomeForHistory } from './GrokHistoryPaths';

export function extractGrokHistoryText(content: unknown): string {
  return readGrokString(content);
}

export function extractGrokUserQueryText(text: string): string {
  const match = text.match(/<user_query>\s*([\s\S]*?)\s*<\/user_query>/);
  return (match ? match[1] : text).trim();
}

export function shouldSkipGrokHistoryUser(
  record: Record<string, unknown>,
  text: string,
): boolean {
  const trimmed = text.trim();
  return !!record.synthetic_reason
    || !trimmed
    || trimmed.startsWith('<user_info>')
    || trimmed.startsWith('<system-reminder>');
}

function readGrokString(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(readGrokString).filter(Boolean).join('');
  }
  if (!value || typeof value !== 'object') {
    return '';
  }

  const record = value as Record<string, unknown>;
  if (typeof record.text === 'string') {
    return record.text;
  }
  if (typeof record.delta === 'string') {
    return record.delta;
  }
  if (typeof record.data === 'string') {
    return record.data;
  }
  if (typeof record.content === 'string') {
    return record.content;
  }
  if (Array.isArray(record.data)) {
    return readGrokString(record.data);
  }
  if (record.data && typeof record.data === 'object') {
    return readGrokString(record.data);
  }
  if (Array.isArray(record.content)) {
    return readGrokString(record.content);
  }
  if (record.content && typeof record.content === 'object') {
    return readGrokString(record.content);
  }
  if (record.message) {
    return readGrokString(record.message);
  }
  return '';
}

export function loadGrokHistoryMessages(
  historyPath: string,
  sessionId: string,
  baseTimestamp: number,
): ChatMessage[] {
  let content: string;
  try {
    content = fs.readFileSync(historyPath, 'utf-8');
  } catch {
    return [];
  }

  const messages: ChatMessage[] = [];
  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) {
      continue;
    }

    let record: Record<string, unknown>;
    try {
      record = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }

    const role = typeof record.type === 'string' ? record.type : '';
    const timestamp = baseTimestamp + messages.length;

    if (role === 'user') {
      const rawText = extractGrokHistoryText(record.content);
      if (shouldSkipGrokHistoryUser(record, rawText)) {
        continue;
      }
      const userText = extractGrokUserQueryText(rawText);
      if (!userText) {
        continue;
      }
      const id = `grok-${sessionId}-${i}-user`;
      messages.push({
        content: userText,
        displayContent: userText,
        id,
        role: 'user',
        timestamp,
        userMessageId: id,
      });
      continue;
    }

    if (role === 'assistant') {
      const assistantText = extractGrokHistoryText(record.content);
      if (!assistantText.trim()) {
        continue;
      }
      const id = `grok-${sessionId}-${i}-assistant`;
      messages.push({
        assistantMessageId: id,
        content: assistantText,
        contentBlocks: [{ type: 'text', content: assistantText }],
        id,
        role: 'assistant',
        timestamp,
      });
    }
  }

  return messages;
}

export class GrokConversationHistoryService implements ProviderConversationHistoryService {
  private hydratedKeys = new Map<string, string>();

  async hydrateConversationHistory(
    conversation: Conversation,
    vaultPath: string | null,
    pathContext?: ProviderHistoryPathContext,
  ): Promise<void> {
    const sessionId = this.resolveSessionIdForConversation(conversation);
    const grokHome = resolveGrokHomeForHistory(conversation, pathContext);
    const historyPath = resolveGrokHistoryFile(vaultPath, sessionId, { grokHome });
    if (!sessionId || !historyPath) {
      this.hydratedKeys.delete(conversation.id);
      return;
    }

    let stat: fs.Stats;
    try {
      stat = fs.statSync(historyPath);
    } catch {
      this.hydratedKeys.delete(conversation.id);
      return;
    }

    const hydrationKey = `${sessionId}::${historyPath}::${stat.mtimeMs}::${stat.size}`;
    if (conversation.messages.length > 0 && this.hydratedKeys.get(conversation.id) === hydrationKey) {
      return;
    }

    const messages = loadGrokHistoryMessages(
      historyPath,
      sessionId,
      typeof conversation.createdAt === 'number' ? conversation.createdAt : Date.now(),
    );
    if (messages.length === 0) {
      this.hydratedKeys.delete(conversation.id);
      return;
    }

    conversation.messages = messages;
    this.hydratedKeys.set(conversation.id, hydrationKey);
  }

  async deleteConversationSession(
    _conversation: Conversation,
    _vaultPath: string | null,
  ): Promise<void> {
    // Never mutate Grok native history.
  }

  resolveSessionIdForConversation(conversation: Conversation | null): string | null {
    return resolveGrokSessionId(conversation);
  }

  isPendingForkConversation(_conversation: Conversation): boolean {
    return false;
  }

  buildForkProviderState(
    sourceSessionId: string,
    resumeAt: string,
    sourceProviderState?: Record<string, unknown>,
  ): Record<string, unknown> {
    return {
      ...(sourceProviderState ?? {}),
      forkSource: { sessionId: sourceSessionId, resumeAt },
    };
  }

  buildPersistedProviderState(
    conversation: Conversation,
  ): Record<string, unknown> | undefined {
    const state = getGrokState(conversation.providerState);
    const sessionId = resolveGrokSessionId(conversation) ?? state.sessionId;
    const providerState: GrokProviderState = {
      ...(sessionId ? { sessionId } : {}),
      ...(state.grokHome ? { grokHome: state.grokHome } : {}),
    };

    return Object.keys(providerState).length > 0
      ? providerState as Record<string, unknown>
      : undefined;
  }
}
