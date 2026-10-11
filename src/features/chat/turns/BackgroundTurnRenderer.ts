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
  readonly renderer: MessageRenderer | null;
  readonly stream: StreamController;
  createMessageId(): string;
}

interface BackgroundTurnRenderResult {
  spans: readonly BackgroundTurnRenderSpan[];
  metadata: { assistantMessageId?: string };
}

export interface BackgroundTurnRenderSpan {
  events: ProviderBackgroundOutputEvent[];
  target?: BackgroundTurnRenderTarget;
}

export interface BackgroundTurnRenderTarget {
  readonly message: ChatMessage;
}

/** Inserts a reply mid-transcript instead of appending an automatic response. */
export interface BackgroundTurnPlacement {
  readonly index: number;
  /** The message whose rendering the reply follows. */
  readonly after?: string;
  readonly automatic: boolean;
}

/** Reserve transcript order before asynchronous rendering or later input. */
export function reserveBackgroundTurn(
  host: Pick<BackgroundTurnRenderHost, 'state' | 'renderer' | 'createMessageId'>,
  placement?: BackgroundTurnPlacement,
): BackgroundTurnRenderTarget {
  const message: ChatMessage = {
    id: host.createMessageId(), role: 'assistant', isAutomaticResponse: placement?.automatic ?? true,
    content: '', timestamp: Date.now(), toolCalls: [], contentBlocks: [],
  };
  const messages = host.state.messages;
  const index = placement?.index ?? messages.length;
  const previous = messages[index - 1];
  if (isStandaloneTaskNotification(previous)) recordResponseContinuation(message, previous);
  if (placement) {
    messages.splice(index, 0, message);
    host.state.messages = messages;
  } else {
    host.state.addMessage(message);
  }
  const element = host.renderer?.addMessage(message, placement?.after) ?? null;
  if (element) element.hidden = true;
  return { message };
}

export function discardBackgroundTurn(host: Pick<BackgroundTurnRenderHost, 'state' | 'renderer'>, target: BackgroundTurnRenderTarget): void {
  const { state } = host;
  host.renderer?.removeMessage(target.message.id);
  if (state.messages.includes(target.message)) {
    state.messages = state.messages.filter(message => message !== target.message);
  }
}

/** The caller admits live session events; detaching the transcript must not drop a notification. */
export function renderSessionTaskNotification(
  host: Pick<BackgroundTurnRenderHost, 'state' | 'renderer' | 'createMessageId'>,
  content: string,
  afterRequestedEvent?: ProviderRequestedEventScope,
  afterBackgroundEvent?: ProviderBackgroundEventScope,
): void {
  const message: ChatMessage = {
    id: host.createMessageId(), role: 'assistant', isAutomaticResponse: true,
    content: '', timestamp: Date.now(),
    contentBlocks: [{ type: 'task_notification', content }],
  };
  recordNotificationPredecessors(message, afterRequestedEvent, afterBackgroundEvent);
  host.state.addMessage(message);
  const element = host.renderer?.addMessage(message) ?? null;
  const contentEl = element?.querySelector<HTMLElement>('.claudian-message-content');
  if (contentEl) host.renderer?.renderTaskNotification(contentEl, content);
  host.renderer?.scrollToBottom();
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
  if (!isCurrent()) {
    return false;
  }

  const { metadata } = result;
  const spans = result.spans.map(span => ({ ...span, chunks: span.events.flatMap(event => {
    const chunk = providerOutputEventToStreamChunk(event);
    return chunk ? [{ chunk, scope: event.scope }] : [];
  }) }));
  const hiddenToolIds = new Set(spans.flatMap(span => span.chunks).flatMap(({ chunk }) =>
    chunk.type === 'tool_use' && chunk.name === TOOL_AGENT_OUTPUT ? [chunk.id] : []
  ));
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
  const segments: ChatMessage[] = [];
  let checkpointMessage: ChatMessage | undefined;

  try {
    for (const span of spans) {
      const start = segments.length;
      const hasVisibleContent = span.chunks.some(({ chunk }) => isVisibleAutoTurnChunk(chunk, hiddenToolIds));
      const target = span.target ?? (hasVisibleContent ? reserveBackgroundTurn(host) : undefined);
      let assistantMessage: ChatMessage = target?.message ?? {
        id: host.createMessageId(), role: 'assistant', content: '', timestamp: Date.now(),
      };
      segments.push(assistantMessage);
      state.response.messageId = assistantMessage.id;
      if (target && !hasVisibleContent) discardBackgroundTurn(host, target);
      state.currentContentEl = hasVisibleContent && target ? host.renderer?.getMessageContentEl(target.message.id) ?? null : null;
      if (state.currentContentEl?.parentElement) state.currentContentEl.parentElement.hidden = false;
      for (const { scope, chunk } of span.chunks) {
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
      await stream.finalizeCurrentThinkingBlock(assistantMessage);
      if (!isCurrent()) return false;
      await stream.finalizeCurrentTextBlock(assistantMessage);
      if (!isCurrent()) return false;
      stream.thinkingIndicator.hide();
      assistantMessage.completedAt = Date.now();
      if (!hasVisibleAutoTurnMessageContent(assistantMessage) && host.state.messages.includes(assistantMessage)) {
        host.state.messages = host.state.messages.filter(message => message !== assistantMessage);
        host.renderer?.removeMessage(assistantMessage.id);
      }
      checkpointMessage = segments.slice(start).reverse().find(segment => host.state.messages.includes(segment));
    }

    const visible = segments.filter(segment => host.state.messages.includes(segment));
    if (checkpointMessage && metadata.assistantMessageId) checkpointMessage.assistantMessageId = metadata.assistantMessageId;
    for (const segment of visible) {
      const previous = getAutomaticNotificationPredecessor(segment, host.state.messages);
      // Include only notification context, never another response's live work.
      host.renderer?.finalizeResponse(segment, previous ? [previous, segment] : [segment]);
    }
    return visible.length > 0;
  } finally {
    stream.dispose();
    host.renderer?.scrollToBottom();
  }
}
