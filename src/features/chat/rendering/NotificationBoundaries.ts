import type { ProviderBackgroundEventScope, ProviderRequestedEventScope, ProviderTurnEventScope } from '../../../core/execution';
import type { ChatMessage } from '../../../core/types';

const predecessors = new WeakMap<ChatMessage, {
  requested?: ProviderRequestedEventScope;
  background?: ProviderBackgroundEventScope;
}>();

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
