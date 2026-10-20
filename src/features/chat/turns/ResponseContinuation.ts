import type { ProviderTurnEventScope } from '@/core/execution';
import type { ChatMessage, StreamChunk } from '@/core/types';
import type { MessageRenderer } from '@/features/chat/rendering/MessageRenderer';
import { getNotificationPredecessor, recordResponseContinuation } from '@/features/chat/rendering/NotificationBoundaries';
import { isStandaloneTaskNotification } from '@/features/chat/rendering/ResponseLayout';
import type { ChatState } from '@/features/chat/state/ChatState';
import type { StreamController } from '@/features/chat/turns/StreamController';

/** One native turn's identity, as its live output events carry it. */
export function getTurnIdentity(scope: ProviderTurnEventScope): string {
  return `${scope.kind}:${scope.sessionInstanceId}:${scope.turnId}`;
}

/** The provider events a stopped turn received notifications after: its own, up to `through`. */
export interface StoppedTurnEvents {
  readonly scope: ProviderTurnEventScope;
  readonly through: number;
}

/** Notifications render ahead of queued output, so only the event each followed tells its turn. */
function arrivedDuring(notification: ChatMessage, turn: StoppedTurnEvents): boolean {
  const predecessor = getNotificationPredecessor(notification, turn.scope.kind);
  return predecessor !== undefined && predecessor.sessionInstanceId === turn.scope.sessionInstanceId
    && predecessor.turnId === turn.scope.turnId && predecessor.sequence <= turn.through
    && (predecessor.kind !== 'requested' || turn.scope.kind !== 'requested' || predecessor.executionId === turn.scope.executionId);
}

/** The last of the notifications the stopped turn received directly after `index`, or `index`. */
export function getTrailingNotificationsEnd(messages: ChatMessage[], index: number, turn: StoppedTurnEvents | undefined): number {
  while (turn && isStandaloneTaskNotification(messages[index + 1]) && arrivedDuring(messages[index + 1], turn)) index++;
  return index;
}

/**
 * A stopped turn ends with the notifications it received after its last output, as
 * native history records them: they take its turn identity so the shared layout folds
 * them with it, and its last message carries the interrupt and shows the indicator
 * until finalization folds the turn. Returns that message.
 */
export function markStoppedTurn(
  renderer: MessageRenderer | null,
  reply: ChatMessage,
  replyContentEl: HTMLElement | null,
  messages: ChatMessage[],
  turn: StoppedTurnEvents | undefined,
): ChatMessage {
  let owner = reply;
  const start = messages.indexOf(reply);
  for (const notification of messages.slice(start + 1, getTrailingNotificationsEnd(messages, start, turn) + 1)) {
    notification.turnId = reply.turnId;
    owner = notification;
  }
  owner.isInterrupt = true;
  const contentEl = owner === reply ? replyContentEl : renderer?.getMessageContentEl(owner.id);
  if (contentEl) renderer?.appendInterruptIndicator(contentEl);
  return owner;
}

/** Latest independent notification that precedes this event but follows its reserved response. */
export function findFollowingNotification(
  message: ChatMessage,
  messages: ChatMessage[],
  scope?: ProviderTurnEventScope,
): ChatMessage | undefined {
  const index = messages.indexOf(message);
  if (index < 0) return undefined;
  return messages.slice(index + 1).filter(item => {
    if (!isStandaloneTaskNotification(item)) return false;
    const predecessor = getNotificationPredecessor(item, scope?.kind ?? 'requested');
    if (scope?.kind === 'background') {
      return predecessor?.kind === 'background'
        && predecessor.sessionInstanceId === scope.sessionInstanceId
        && predecessor.turnId === scope.turnId
        && predecessor.sequence < scope.sequence;
    }
    return !scope || !predecessor
      || predecessor.sessionInstanceId !== scope.sessionInstanceId
      || (predecessor.kind === 'requested' && predecessor.executionId !== scope.executionId)
      || predecessor.turnId !== scope.turnId
      || predecessor.sequence < scope.sequence;
  }).at(-1);
}

/** Keep new response content after independently delivered session notifications. */
export async function continueResponseAfterNotification(
  host: {
    state: ChatState;
    renderer: MessageRenderer | null;
    stream: StreamController;
    /** Automatic rendering has private streaming buffers but shares transcript order. */
    streamState?: ChatState;
    isCurrent?(): boolean;
    createMessageId(): string;
  },
  message: ChatMessage,
  chunk: StreamChunk,
  scope?: ProviderTurnEventScope,
): Promise<ChatMessage> {
  if ((chunk.type === 'text' || chunk.type === 'thinking') && chunk.content.length === 0) return message;
  if (!['text', 'thinking', 'citations', 'tool_use', 'notice', 'error', 'context_compacted'].includes(chunk.type)) return message;
  // Repeated tool snapshots update the existing card instead of starting a new segment.
  if (chunk.type === 'tool_use' && host.state.messages.some(item => item.toolCalls?.some(tool => tool.id === chunk.id))) {
    return message;
  }
  const preceding = findFollowingNotification(message, host.state.messages, scope);
  if (!preceding) return message;

  await host.stream.handleStreamChunk({ type: 'done' }, message);
  await host.stream.finalizeCurrentThinkingBlock(message);
  await host.stream.finalizeCurrentTextBlock(message);
  if (host.isCurrent?.() === false
    || !host.state.messages.includes(message) || !host.state.messages.includes(preceding)) return message;
  host.stream.thinkingIndicator.hide();
  // Requested responses retain their starting position for the completed work disclosure.
  if (message.isAutomaticResponse && !message.content
    && !message.contentBlocks?.length && !message.toolCalls?.length) {
    host.state.messages = host.state.messages.filter(item => item !== message);
    host.renderer?.removeMessage(message.id);
  }
  const continuation: ChatMessage = {
    id: host.createMessageId(), role: 'assistant', content: '', timestamp: Date.now(),
    toolCalls: [], contentBlocks: [],
    ...(message.isAutomaticResponse ? { isAutomaticResponse: true } : {}),
  };
  recordResponseContinuation(continuation, message.isAutomaticResponse ? preceding : message);
  const insertionIndex = host.state.messages.indexOf(preceding) + 1;
  const messages = host.state.messages;
  messages.splice(insertionIndex, 0, continuation);
  host.state.messages = messages;
  (host.streamState ?? host.state).response.messageId = continuation.id;
  const element = host.renderer?.addMessage(continuation);
  element?.parentElement?.querySelector(`[data-message-id="${preceding.id}"]`)?.after(element);
  (host.streamState ?? host.state).currentContentEl = element?.querySelector<HTMLElement>('.claudian-message-content') ?? null;
  return continuation;
}
