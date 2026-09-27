import type { ProviderBackgroundEventScope, ProviderRequestedEventScope, ProviderTurnEventScope } from '../../../core/execution';
import type { ChatMessage } from '../../../core/types';

const predecessors = new WeakMap<ChatMessage, {
  requested?: ProviderRequestedEventScope;
  background?: ProviderBackgroundEventScope;
}>();

const responsePredecessors = new WeakMap<ChatMessage, ChatMessage>();

export function recordResponseContinuation(message: ChatMessage, previous: ChatMessage): void {
  responsePredecessors.set(message, previous);
}

/** Display splits keep their response owner even when notifications interleave. */
export function getResponseSegments(message: ChatMessage, messages: ChatMessage[]): ChatMessage[] {
  const segments = [message];
  let current = message;
  let previous: ChatMessage | undefined;
  while ((previous = responsePredecessors.get(current))) {
    const start = messages.indexOf(previous);
    const end = messages.indexOf(current);
    if (start < 0 || start >= end || messages.slice(start, end).some(item =>
      item.role === 'user' || item.isInterrupt
      || item.contentBlocks?.some(block => block.type === 'context_compacted'))) break;
    segments.unshift(previous);
    current = previous;
  }
  return segments;
}

/** Rendering positions are ephemeral; native history supplies its own order on reload. */
export function recordNotificationPredecessors(
  message: ChatMessage,
  requested?: ProviderRequestedEventScope,
  background?: ProviderBackgroundEventScope,
): void {
  predecessors.set(message, { requested, background });
}

export function getNotificationPredecessor(
  message: ChatMessage,
  kind: ProviderTurnEventScope['kind'],
): ProviderTurnEventScope | undefined {
  return predecessors.get(message)?.[kind];
}
