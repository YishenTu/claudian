import type { ProviderTurnEventScope } from '../../../core/execution';
import type { ChatMessage, StreamChunk } from '../../../core/types';
import type { StreamController } from '../controllers/StreamController';
import type { ChatState } from '../state/ChatState';
import { isStandaloneTaskNotification, type MessageRenderer } from './MessageRenderer';
import { getNotificationPredecessor } from './NotificationBoundaries';

/** Keep new response content after independently delivered session notifications. */
export async function continueResponseAfterNotification(
  host: {
    state: ChatState;
    renderer: MessageRenderer;
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
  if (!['text', 'thinking', 'citations', 'tool_use', 'notice', 'error', 'context_compacted'].includes(chunk.type)) return message;
  // Repeated tool snapshots update the existing card instead of starting a new segment.
  if (chunk.type === 'tool_use' && host.state.messages.some(item => item.toolCalls?.some(tool => tool.id === chunk.id))) {
    return message;
  }
  const index = host.state.messages.indexOf(message);
  if (index < 0) return message;
  const preceding = host.state.messages.slice(index + 1).filter(item => {
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
  if (!preceding) return message;

  await host.stream.handleStreamChunk({ type: 'done' }, message);
  await host.stream.finalizeCurrentThinkingBlock(message);
  await host.stream.finalizeCurrentTextBlock(message);
  if (host.isCurrent?.() === false
    || !host.state.messages.includes(message) || !host.state.messages.includes(preceding)) return message;
  host.stream.hideThinkingIndicator();
  if (!message.content && !message.contentBlocks?.length && !message.toolCalls?.length) {
    host.state.messages = host.state.messages.filter(item => item !== message);
    host.renderer.removeMessage(message.id);
  }
  const continuation: ChatMessage = {
    id: host.createMessageId(), role: 'assistant', content: '', timestamp: Date.now(),
    toolCalls: [], contentBlocks: [],
    ...(message.isAutomaticResponse ? { isAutomaticResponse: true } : {}),
  };
  const insertionIndex = host.state.messages.indexOf(preceding) + 1;
  const messages = host.state.messages;
  messages.splice(insertionIndex, 0, continuation);
  host.state.messages = messages;
  const element = host.renderer.addMessage(continuation);
  element.parentElement?.querySelector(`[data-message-id="${preceding.id}"]`)?.after(element);
  (host.streamState ?? host.state).currentContentEl = element.querySelector<HTMLElement>('.claudian-message-content');
  return continuation;
}
