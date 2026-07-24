import type { SessionMessage } from '@qoder-ai/qoder-agent-sdk';

import type {
  ProviderConversationHistoryService,
  ProviderHistoryPathContext,
} from '../../../core/providers/types';
import type {
  ChatMessage,
  Conversation,
  ImageAttachment,
  ToolCallInfo,
} from '../../../core/types';
import {
  buildImageAttachmentFromBase64,
  parseImageDataUri,
} from '../../../utils/imageAttachment';
import { loadQoderSdkModule } from '../runtime/loadQoderSdk';
import {
  buildPersistedQoderProviderState,
  parseQoderProviderState,
} from '../types';

export class QoderConversationHistoryService implements ProviderConversationHistoryService {
  private readonly hydratedKeys = new Map<string, string>();

  async hydrateConversationHistory(
    conversation: Conversation,
    vaultPath: string | null,
    _pathContext?: ProviderHistoryPathContext,
  ): Promise<void> {
    const state = parseQoderProviderState(conversation.providerState);
    const pendingFork = this.isPendingForkConversation(conversation);
    const sessionId = pendingFork
      ? state.forkSource?.sessionId
      : state.sessionId ?? conversation.sessionId;
    if (!sessionId) {
      this.hydratedKeys.delete(conversation.id);
      return;
    }

    const checkpoint = pendingFork ? state.forkSource?.resumeAt : undefined;
    const hydrationKey = `${sessionId}::${checkpoint ?? ''}::${vaultPath ?? ''}`;
    if (
      conversation.messages.length > 0
      && this.hydratedKeys.get(conversation.id) === hydrationKey
    ) {
      return;
    }

    try {
      const { getSessionMessages } = await loadQoderSdkModule();
      const nativeMessages = await getSessionMessages(sessionId, {
        ...(vaultPath ? { dir: vaultPath } : {}),
        includeSystemMessages: true,
      });
      const scopedMessages = checkpoint
        ? sliceQoderSessionMessagesAt(nativeMessages, checkpoint)
        : nativeMessages;
      const messages = mapQoderSessionMessages(scopedMessages);
      if (messages.length === 0) {
        this.hydratedKeys.delete(conversation.id);
        return;
      }
      conversation.messages = messages;
      this.hydratedKeys.set(conversation.id, hydrationKey);
    } catch {
      this.hydratedKeys.delete(conversation.id);
    }
  }

  async deleteConversationSession(_conversation: Conversation): Promise<void> {
    // Never mutate Qoder-native history.
  }

  resolveSessionIdForConversation(conversation: Conversation | null): string | null {
    const state = parseQoderProviderState(conversation?.providerState);
    return state.sessionId ?? conversation?.sessionId ?? null;
  }

  isPendingForkConversation(conversation: Conversation): boolean {
    const state = parseQoderProviderState(conversation.providerState);
    return Boolean(state.forkSource && !state.sessionId && !conversation.sessionId);
  }

  buildForkProviderState(
    sourceSessionId: string,
    resumeAt: string,
    sourceProviderState?: Record<string, unknown>,
  ): Record<string, unknown> {
    const state = parseQoderProviderState(sourceProviderState);
    return buildPersistedQoderProviderState({
      ...state,
      forkSource: {
        resumeAt,
        sessionId: sourceSessionId,
      },
    }) as Record<string, unknown> | undefined ?? {};
  }

  buildPersistedProviderState(conversation: Conversation): Record<string, unknown> | undefined {
    return buildPersistedQoderProviderState(
      parseQoderProviderState(conversation.providerState),
    ) as Record<string, unknown> | undefined;
  }
}

export function sliceQoderSessionMessagesAt(
  messages: readonly SessionMessage[],
  checkpointId: string,
): SessionMessage[] {
  const checkpointIndex = messages.findIndex(message => message.uuid === checkpointId);
  return checkpointIndex >= 0
    ? messages.slice(0, checkpointIndex + 1)
    : [];
}

export function mapQoderSessionMessages(
  messages: readonly SessionMessage[],
): ChatMessage[] {
  const result: ChatMessage[] = [];

  for (const entry of messages) {
    const message = readRecord(entry.message);
    const blocks = Array.isArray(message?.content) ? message.content : [];
    if (entry.type === 'user') {
      const text = blocks
        .map(readRecord)
        .filter((block): block is Record<string, unknown> => block?.type === 'text')
        .map(block => typeof block.text === 'string' ? block.text : '')
        .filter(Boolean)
        .join('\n');
      const images = extractQoderImages(blocks, entry.uuid);
      if (text || images.length > 0) {
        result.push({
          content: text,
          id: entry.uuid,
          ...(images.length > 0 ? { images } : {}),
          role: 'user',
          timestamp: parseTimestamp(entry.timestamp),
          userMessageId: entry.uuid,
        });
      }
      applyQoderToolResults(result, blocks);
      continue;
    }

    if (entry.type !== 'assistant') {
      continue;
    }

    let assistant = result[result.length - 1];
    if (!assistant || assistant.role !== 'assistant') {
      assistant = {
        assistantMessageId: entry.uuid,
        content: '',
        contentBlocks: [],
        id: entry.uuid,
        role: 'assistant',
        timestamp: parseTimestamp(entry.timestamp),
        toolCalls: [],
      };
      result.push(assistant);
    } else {
      assistant.assistantMessageId = entry.uuid;
    }

    for (const value of blocks) {
      const block = readRecord(value);
      if (!block) {
        continue;
      }
      if (block.type === 'text' && typeof block.text === 'string' && block.text) {
        assistant.content += block.text;
        assistant.contentBlocks?.push({ content: block.text, type: 'text' });
      } else if (
        block.type === 'thinking'
        && typeof block.thinking === 'string'
        && block.thinking
      ) {
        assistant.contentBlocks?.push({ content: block.thinking, type: 'thinking' });
      } else if (block.type === 'tool_use') {
        const id = typeof block.id === 'string' ? block.id : entry.uuid;
        const toolCall: ToolCallInfo = {
          id,
          input: readRecord(block.input) ?? {},
          name: typeof block.name === 'string' ? block.name : 'Tool',
          status: 'running',
        };
        assistant.toolCalls?.push(toolCall);
        assistant.contentBlocks?.push({ toolId: id, type: 'tool_use' });
      }
    }
  }

  for (const message of result) {
    if (message.toolCalls?.length === 0) {
      delete message.toolCalls;
    }
    if (message.contentBlocks?.length === 0) {
      delete message.contentBlocks;
    }
  }
  return result;
}

function extractQoderImages(
  blocks: unknown[],
  messageId: string,
): ImageAttachment[] {
  const images: ImageAttachment[] = [];
  for (const value of blocks) {
    const block = readRecord(value);
    const source = readRecord(block?.source);
    if (
      block?.type !== 'image'
      || source?.type !== 'base64'
      || typeof source.data !== 'string'
    ) {
      continue;
    }
    const parsedDataUri = parseImageDataUri(source.data);
    const image = buildImageAttachmentFromBase64({
      data: parsedDataUri?.data ?? source.data,
      id: `qoder-img-${messageId}-${images.length}`,
      mediaType: parsedDataUri?.mediaType
        ?? (typeof source.media_type === 'string' ? source.media_type : ''),
      name: `image-${images.length + 1}`,
    });
    if (image) {
      images.push(image);
    }
  }
  return images;
}

function applyQoderToolResults(result: ChatMessage[], blocks: unknown[]): void {
  const assistant = [...result].reverse().find(message => message.role === 'assistant');
  if (!assistant?.toolCalls) {
    return;
  }
  for (const value of blocks) {
    const block = readRecord(value);
    if (block?.type !== 'tool_result' || typeof block.tool_use_id !== 'string') {
      continue;
    }
    const toolCall = assistant.toolCalls.find(call => call.id === block.tool_use_id);
    if (!toolCall) {
      continue;
    }
    toolCall.result = readToolResultContent(block.content);
    toolCall.status = block.is_error === true ? 'error' : 'completed';
  }
}

function readToolResultContent(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  if (!Array.isArray(value)) {
    return '';
  }
  return value
    .map(readRecord)
    .map(block => typeof block?.text === 'string' ? block.text : '')
    .filter(Boolean)
    .join('\n');
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function parseTimestamp(value: string | undefined): number {
  const timestamp = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(timestamp) ? timestamp : Date.now();
}
