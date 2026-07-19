import * as fs from 'fs';

import type {
  ProviderConversationHistoryService,
  ProviderHistoryPathContext,
} from '../../../core/providers/types';
import type { ChatMessage, Conversation } from '../../../core/types';
import { getKimiState, type KimiProviderState, resolveKimiSessionId } from '../types';
import {
  resolveKimiCodeHomeForHistory,
  resolveKimiHistoryFile,
} from './KimiHistoryPaths';

function readTextContent(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(readTextContent).filter(Boolean).join('');
  }
  if (!value || typeof value !== 'object') {
    return '';
  }

  const record = value as Record<string, unknown>;
  if (typeof record.text === 'string') {
    return record.text;
  }
  if (typeof record.content === 'string') {
    return record.content;
  }
  if (Array.isArray(record.content)) {
    return readTextContent(record.content);
  }
  if (record.content && typeof record.content === 'object') {
    return readTextContent(record.content);
  }
  if (record.message) {
    return readTextContent(record.message);
  }
  if (record.delta) {
    return readTextContent(record.delta);
  }
  return '';
}

function resolveRecordTime(record: Record<string, unknown>, fallback: number): number {
  return typeof record.time === 'number' && Number.isFinite(record.time)
    ? record.time
    : fallback;
}

function appendHistoryMessage(
  messages: ChatMessage[],
  role: 'assistant' | 'user',
  text: string,
  sessionId: string,
  recordIndex: number,
  timestamp: number,
): void {
  const content = text.trim();
  if (!content) {
    return;
  }

  const id = `kimi-${sessionId}-${recordIndex}-${role}`;
  if (role === 'user') {
    messages.push({
      content,
      displayContent: content,
      id,
      role: 'user',
      timestamp,
      userMessageId: id,
    });
    return;
  }

  messages.push({
    assistantMessageId: id,
    content,
    contentBlocks: [{ type: 'text', content }],
    id,
    role: 'assistant',
    timestamp,
  });
}

/** Rebuild user and assistant text from Kimi Code's AgentRecord wire log. */
export function loadKimiHistoryMessages(
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
  const openAssistantSteps = new Map<string, {
    recordIndex: number;
    text: string;
    timestamp: number;
  }>();
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

    const type = typeof record.type === 'string' ? record.type : '';
    const timestamp = resolveRecordTime(record, baseTimestamp + i);

    if (type === 'context.append_message') {
      const message = record.message;
      if (!message || typeof message !== 'object' || Array.isArray(message)) {
        continue;
      }
      const messageRecord = message as Record<string, unknown>;
      const origin = messageRecord.origin;
      const originKind = origin && typeof origin === 'object' && !Array.isArray(origin)
        ? (origin as Record<string, unknown>).kind
        : undefined;
      if (originKind === 'compaction_summary' || originKind === 'injection') {
        continue;
      }
      const role = messageRecord.role;
      if (role === 'user' || role === 'assistant') {
        appendHistoryMessage(
          messages,
          role,
          readTextContent(messageRecord.content),
          sessionId,
          i,
          timestamp,
        );
      }
      continue;
    }

    if (type !== 'context.append_loop_event') {
      continue;
    }
    const event = record.event;
    if (!event || typeof event !== 'object' || Array.isArray(event)) {
      continue;
    }
    const eventRecord = event as Record<string, unknown>;
    const eventType = eventRecord.type;
    const stepUuid = typeof eventRecord.stepUuid === 'string'
      ? eventRecord.stepUuid
      : typeof eventRecord.uuid === 'string'
      ? eventRecord.uuid
      : '';

    if (eventType === 'step.begin' && stepUuid) {
      openAssistantSteps.set(stepUuid, { recordIndex: i, text: '', timestamp });
      continue;
    }
    if (eventType === 'content.part' && stepUuid) {
      const step = openAssistantSteps.get(stepUuid);
      if (step) {
        step.text += readTextContent(eventRecord.part);
      }
      continue;
    }
    if (eventType === 'step.end' && stepUuid) {
      const step = openAssistantSteps.get(stepUuid);
      if (step) {
        appendHistoryMessage(
          messages,
          'assistant',
          step.text,
          sessionId,
          step.recordIndex,
          step.timestamp,
        );
        openAssistantSteps.delete(stepUuid);
      }
    }
  }

  for (const step of openAssistantSteps.values()) {
    appendHistoryMessage(
      messages,
      'assistant',
      step.text,
      sessionId,
      step.recordIndex,
      step.timestamp,
    );
  }

  return messages;
}

export class KimiConversationHistoryService implements ProviderConversationHistoryService {
  private hydratedKeys = new Map<string, string>();

  async hydrateConversationHistory(
    conversation: Conversation,
    vaultPath: string | null,
    pathContext?: ProviderHistoryPathContext,
  ): Promise<void> {
    const sessionId = this.resolveSessionIdForConversation(conversation);
    const kimiCodeHome = resolveKimiCodeHomeForHistory(conversation, pathContext);
    const historyPath = resolveKimiHistoryFile(vaultPath, sessionId, { kimiCodeHome });
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

    const messages = loadKimiHistoryMessages(
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
    // Never mutate Kimi native history.
  }

  resolveSessionIdForConversation(conversation: Conversation | null): string | null {
    return resolveKimiSessionId(conversation);
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
    const state = getKimiState(conversation.providerState);
    const sessionId = resolveKimiSessionId(conversation) ?? state.sessionId;
    const providerState: KimiProviderState = {
      ...(sessionId ? { sessionId } : {}),
      ...(state.kimiCodeHome ? { kimiCodeHome: state.kimiCodeHome } : {}),
    };

    return Object.keys(providerState).length > 0
      ? providerState as Record<string, unknown>
      : undefined;
  }
}
