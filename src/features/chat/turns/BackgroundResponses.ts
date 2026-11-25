import type { ProviderBackgroundOutputEvent, ProviderSessionEvent, ProviderUserMessageStartedEvent } from '@/core/execution';
import type { ChatMessage } from '@/core/types';
import {
  AutoTriggeredTurn,
  type BackgroundTurnRenderHost,
  reserveBackgroundTurn,
} from '@/features/chat/turns/BackgroundTurnRenderer';
import { findFollowingNotification } from '@/features/chat/turns/ResponseContinuation';
import type { PendingProviderUserMessage } from '@/features/chat/turns/TurnSteering';

/** Reserves transcript order at admission, then renders the owning session's output as it arrives. */
export class BackgroundResponses {
  readonly #owners = new Map<string, Map<string, AutoTriggeredTurn>>();

  constructor(private readonly host: BackgroundTurnRenderHost) {}

  reserve(owner: string, turnId: string): void {
    let turns = this.#owners.get(owner);
    if (!turns) this.#owners.set(owner, turns = new Map<string, AutoTriggeredTurn>());
    if (turns.has(turnId)) return;
    turns.set(turnId, new AutoTriggeredTurn(this.host, reserveBackgroundTurn(this.host)));
  }

  /** Capture each user boundary synchronously; queued output is assigned by provider sequence, not processing time. */
  userMessage(owner: string, event: ProviderUserMessageStartedEvent, expected?: PendingProviderUserMessage | null): ChatMessage | undefined {
    const response = this.#owners.get(owner)?.get(event.scope.turnId);
    const previous = response?.insertionAnchor;
    if (!response || !previous) return;
    const displayContent = expected?.displayContent ?? event.content ?? '';
    const message: ChatMessage = {
      id: this.host.createMessageId(), role: 'user', timestamp: Date.now(),
      content: expected?.persistedContent ?? displayContent, displayContent,
      images: expected?.images, linkedContentPath: expected?.linkedContentPath,
      userMessageId: event.nativeUserMessageId,
    };
    const messages = this.host.state.messages;
    const anchor = findFollowingNotification(previous, messages, event.scope) ?? previous;
    const index = messages.indexOf(anchor);
    if (index < 0) return;
    messages.splice(index + 1, 0, message);
    this.host.state.messages = messages;
    this.host.renderer?.addMessage(message, anchor.id);
    // Reserve the new reply beside its user, ahead of input admitted after this background turn.
    const target = reserveBackgroundTurn(this.host, { index: index + 2, after: message.id, automatic: false });
    response.addSpan(event.scope.sequence, message, target);
    this.host.state.markConversationDirty();
    return message;
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
      await response.push(event as ProviderBackgroundOutputEvent, isCurrent);
      return undefined;
    }
    turns!.delete(event.scope.turnId);
    if (!turns!.size) this.#owners.delete(owner);
    const visible = await response.complete(
      { assistantMessageId: event.nativeAssistantId },
      event.reason === 'interrupted' ? event.scope : undefined,
      isCurrent,
    );
    return visible || response.hasUserMessages;
  }

  /** Where settled history ends in `messages`: before the first message of an automatic turn still running. */
  settledTranscriptEnd(messages: readonly ChatMessage[]): number {
    let end = messages.length;
    for (const turns of this.#owners.values()) {
      for (const turn of turns.values()) {
        const start = turn.transcriptStart(messages);
        if (start >= 0) end = Math.min(end, start);
      }
    }
    return end;
  }

  discard(owner?: string): void {
    const owners = owner === undefined ? [...this.#owners.keys()] : [owner];
    for (const id of owners) {
      for (const response of this.#owners.get(id)?.values() ?? []) response.discard();
      this.#owners.delete(id);
    }
  }
}
