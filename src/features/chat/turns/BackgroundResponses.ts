import type { ProviderBackgroundOutputEvent, ProviderSessionEvent, ProviderUserMessageStartedEvent } from '@/core/execution';
import type { ChatMessage } from '@/core/types';
import {
  type BackgroundTurnRenderHost,
  type BackgroundTurnRenderSpan,
  discardBackgroundTurn,
  renderAutoTriggeredTurn,
  reserveBackgroundTurn,
} from '@/features/chat/turns/BackgroundTurnRenderer';
import { findFollowingNotification } from '@/features/chat/turns/ResponseContinuation';
import type { PendingProviderUserMessage } from '@/features/chat/turns/TurnSteering';

interface BackgroundResponse {
  readonly spans: Array<BackgroundTurnRenderSpan & { afterSequence: number; user?: ChatMessage }>;
}

/** Reserves transcript order at admission, then renders only the owning session's buffered output. */
export class BackgroundResponses {
  readonly #owners = new Map<string, Map<string, BackgroundResponse>>();

  constructor(private readonly host: BackgroundTurnRenderHost) {}

  reserve(owner: string, turnId: string): void {
    let turns = this.#owners.get(owner);
    if (!turns) this.#owners.set(owner, turns = new Map<string, BackgroundResponse>());
    if (turns.has(turnId)) return;
    turns.set(turnId, {
      spans: [{ afterSequence: 0, events: [], target: reserveBackgroundTurn(this.host) }],
    });
  }

  /** Capture each user boundary synchronously; queued output is assigned by provider sequence, not processing time. */
  userMessage(owner: string, event: ProviderUserMessageStartedEvent, expected?: PendingProviderUserMessage | null): void {
    const response = this.#owners.get(owner)?.get(event.scope.turnId);
    const previous = response?.spans.at(-1)?.target;
    if (!response || !previous) return;
    const displayContent = expected?.displayContent ?? event.content ?? '';
    const message: ChatMessage = {
      id: this.host.createMessageId(), role: 'user', timestamp: Date.now(),
      content: expected?.persistedContent ?? displayContent, displayContent,
      images: expected?.images, linkedContentPath: expected?.linkedContentPath,
      userMessageId: event.nativeUserMessageId,
    };
    const messages = this.host.state.messages;
    const anchor = findFollowingNotification(previous.message, messages, event.scope) ?? previous.message;
    const index = messages.indexOf(anchor);
    if (index < 0) return;
    messages.splice(index + 1, 0, message);
    this.host.state.messages = messages;
    this.host.renderer?.addMessage(message, anchor.id);
    // Reserve the new reply beside its user, ahead of input admitted after this background turn.
    const target = reserveBackgroundTurn(this.host, { index: index + 2, after: message.id, automatic: false });
    response.spans.push({ afterSequence: event.scope.sequence, user: message, target, events: [] });
    this.host.state.hasPendingConversationSave = true;
  }

  /** Undefined means no response completed; false means completion without visible output. */
  async handle(owner: string, event: ProviderSessionEvent, isCurrent: () => boolean): Promise<boolean | undefined> {
    if (!isCurrent()) {
      this.discard(owner);
      return undefined;
    }
    if (event.scope.kind !== 'background' || event.type === 'background_turn_started') return undefined;
    const turns = this.#owners.get(owner);
    const response = turns?.get(event.scope.turnId);
    if (!response) return undefined;
    if (event.type === 'user_message_started') return undefined;
    if (event.type !== 'background_turn_completed') {
      [...response.spans].reverse().find(span => span.afterSequence < event.scope.sequence)?.events.push(event as ProviderBackgroundOutputEvent);
      return undefined;
    }
    turns!.delete(event.scope.turnId);
    if (!turns!.size) this.#owners.delete(owner);
    const visible = await renderAutoTriggeredTurn(this.host, {
      spans: response.spans,
      metadata: { assistantMessageId: event.nativeAssistantId },
    }, isCurrent);
    return visible || response.spans.some(span => span.user !== undefined);
  }

  discard(owner?: string): void {
    const owners = owner === undefined ? [...this.#owners.keys()] : [owner];
    for (const id of owners) {
      for (const response of this.#owners.get(id)?.values() ?? []) {
        for (const span of response.spans) {
          if (span.target) discardBackgroundTurn(this.host, span.target);
          if (span.user) {
            this.host.renderer?.removeMessage(span.user.id);
            this.host.state.messages = this.host.state.messages.filter(message => message !== span.user);
          }
        }
      }
      this.#owners.delete(id);
    }
  }
}
