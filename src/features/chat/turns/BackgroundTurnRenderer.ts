import type { ProviderBackgroundEventScope, ProviderBackgroundOutputEvent, ProviderRequestedEventScope } from '@/core/execution';
import { TOOL_AGENT_OUTPUT } from '@/core/tools/toolNames';
import type { ChatMessage, StreamChunk } from '@/core/types';
import type { MessageRenderer } from '@/features/chat/rendering/MessageRenderer';
import { recordNotificationPredecessors, recordResponseContinuation } from '@/features/chat/rendering/NotificationBoundaries';
import { providerOutputEventToStreamChunk } from '@/features/chat/rendering/providerOutputChunks';
import { getAutomaticNotificationPredecessor, isStandaloneTaskNotification } from '@/features/chat/rendering/ResponseLayout';
import { ChatState } from '@/features/chat/state/ChatState';
import { continueResponseAfterNotification } from '@/features/chat/turns/ResponseContinuation';
import type { StreamController } from '@/features/chat/turns/StreamController';

export interface BackgroundTurnRenderHost {
  readonly state: ChatState;
  readonly renderer: MessageRenderer;
  readonly stream: StreamController;
  isConnected(): boolean;
  createMessageId(): string;
}

interface BackgroundTurnRenderResult {
  events: readonly ProviderBackgroundOutputEvent[];
  metadata: { assistantMessageId?: string };
  target?: BackgroundTurnRenderTarget;
}

export interface BackgroundTurnRenderTarget {
  readonly message: ChatMessage;
  readonly element: HTMLElement;
}

/** Reserve transcript order before asynchronous rendering or later input. */
export function reserveBackgroundTurn(
  host: Pick<BackgroundTurnRenderHost, 'state' | 'renderer' | 'createMessageId'>,
): BackgroundTurnRenderTarget {
  const message: ChatMessage = {
    id: host.createMessageId(), role: 'assistant', isAutomaticResponse: true,
    content: '', timestamp: Date.now(), toolCalls: [], contentBlocks: [],
  };
  const previous = host.state.messages.at(-1);
  if (isStandaloneTaskNotification(previous)) recordResponseContinuation(message, previous);
  host.state.addMessage(message);
  const element = host.renderer.addMessage(message);
  element.hidden = true;
  return { message, element };
}

export function discardBackgroundTurn(state: ChatState, target: BackgroundTurnRenderTarget): void {
  target.element.remove();
  if (state.messages.includes(target.message)) {
    state.messages = state.messages.filter(message => message !== target.message);
  }
}

/** A task can finish during any turn; its disclosure must not borrow live stream state. */
export function renderSessionTaskNotification(
  host: Pick<BackgroundTurnRenderHost, 'state' | 'renderer' | 'isConnected' | 'createMessageId'>,
  content: string,
  afterRequestedEvent?: ProviderRequestedEventScope,
  afterBackgroundEvent?: ProviderBackgroundEventScope,
): void {
  if (!host.isConnected()) return;
  const message: ChatMessage = {
    id: host.createMessageId(), role: 'assistant', isAutomaticResponse: true,
    content: '', timestamp: Date.now(),
    contentBlocks: [{ type: 'task_notification', content }],
  };
  recordNotificationPredecessors(message, afterRequestedEvent, afterBackgroundEvent);
  host.state.addMessage(message);
  const element = host.renderer.addMessage(message);
  const contentEl = element.querySelector<HTMLElement>('.claudian-message-content');
  if (contentEl) host.renderer.renderTaskNotification(contentEl, content);
  host.renderer.scrollToBottom();
}

function isVisibleAutoTurnChunk(chunk: StreamChunk, hiddenToolIds: Set<string>): boolean {
  switch (chunk.type) {
    case 'text':
      return chunk.content.trim().length > 0;
    case 'thinking':
    case 'citations':
    case 'notice':
    case 'error':
    case 'tool_output':
    case 'context_compacted':
    case 'task_notification':
    case 'subagent_tool_use':
    case 'subagent_tool_result':
      return true;
    case 'tool_use':
      return chunk.name !== TOOL_AGENT_OUTPUT;
    case 'tool_result':
      return !hiddenToolIds.has(chunk.id);
    default:
      return false;
  }
}

function hasVisibleAutoTurnMessageContent(message: ChatMessage): boolean {
  if (message.content.trim().length > 0) return true;
  if (message.toolCalls && message.toolCalls.length > 0) return true;
  return message.contentBlocks?.some(block =>
    block.type !== 'text' || block.content.trim().length > 0
  ) ?? false;
}

/** Render a settled native background turn; the caller owns storage and execution lifetime. */
export async function renderAutoTriggeredTurn(
  host: BackgroundTurnRenderHost,
  result: BackgroundTurnRenderResult,
  isCurrent: () => boolean,
): Promise<boolean> {
  if (!isCurrent() || !host.isConnected()) {
    return false;
  }

  const { metadata } = result;
  const chunks = result.events.flatMap(event => {
    const chunk = providerOutputEventToStreamChunk(event);
    return chunk ? [{ chunk, scope: event.scope }] : [];
  });
  if (chunks.length === 0) {
    if (result.target) discardBackgroundTurn(host.state, result.target);
    return false;
  }

  const hiddenToolIds = new Set(chunks.flatMap(({ chunk }) =>
    chunk.type === 'tool_use' && chunk.name === TOOL_AGENT_OUTPUT ? [chunk.id] : []
  ));
  const hasVisibleContent = chunks.some(({ chunk }) => isVisibleAutoTurnChunk(chunk, hiddenToolIds));

  const target = result.target ?? (hasVisibleContent ? reserveBackgroundTurn(host) : undefined);
  let assistantMessage: ChatMessage = target?.message ?? {
    id: host.createMessageId(), role: 'assistant', content: '', timestamp: Date.now(),
  };
  const segments = [assistantMessage];
  if (!hasVisibleContent && target) discardBackgroundTurn(host.state, target);

  const state = new ChatState({
    onUsageChanged: usage => {
      if (isCurrent() && !host.state.isStreaming) {
        if (usage) host.state.reportUsage(usage);
        else host.state.usage = null;
      }
    },
  });
  state.currentConversationId = host.state.currentConversationId;
  state.autoScrollEnabled = host.state.autoScrollEnabled;
  const stream = host.stream.createBackgroundStream(state);

  if (hasVisibleContent && target) {
    target.element.hidden = false;
    state.currentContentEl = target.element.querySelector<HTMLElement>('.claudian-message-content');
  }
  state.messages = host.state.messages;

  try {
    for (const { scope, chunk } of chunks) {
      if (!isCurrent()) return false;
      if (hasVisibleContent) {
        const continuation = await continueResponseAfterNotification({
          state: host.state, streamState: state, renderer: host.renderer, stream,
          createMessageId: () => host.createMessageId(), isCurrent,
        }, assistantMessage, chunk, scope);
        if (!isCurrent()) return false;
        if (continuation !== assistantMessage) {
          assistantMessage = continuation;
          segments.push(continuation);
        }
      }
      state.messages = host.state.messages;
      await stream.handleStreamChunk(chunk, assistantMessage);
      if (!isCurrent()) return false;
    }

    if (!isCurrent()) return false;
    await stream.handleStreamChunk({ type: 'done' }, assistantMessage);

    if (
      isCurrent()
      && hasVisibleContent
      && !hasVisibleAutoTurnMessageContent(assistantMessage)
    ) {
      const placeholder = '(background task completed)';
      assistantMessage.content = placeholder;
      await stream.appendText(placeholder);
    }

    if (isCurrent() && hasVisibleContent) {
      await stream.finalizeCurrentThinkingBlock(assistantMessage);
      if (!isCurrent()) return false;
      await stream.finalizeCurrentTextBlock(assistantMessage);
      if (!isCurrent()) return false;
      assistantMessage.completedAt = Date.now();
      if (metadata.assistantMessageId) assistantMessage.assistantMessageId = metadata.assistantMessageId;
      for (const segment of segments) {
        if (!host.state.messages.includes(segment)) continue;
        const previous = getAutomaticNotificationPredecessor(segment, host.state.messages);
        // Include only notification context, never another response's live work.
        const responseMessages = previous ? [previous, segment] : [segment];
        host.renderer.finalizeResponse(segment, responseMessages);
      }
    }
  } finally {
    stream.dispose();
    if (hasVisibleContent) host.renderer.scrollToBottom();
  }
  return hasVisibleContent;
}
