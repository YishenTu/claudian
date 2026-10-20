import type { ProviderExecutionEvent, ProviderTurnEventScope } from '@/core/execution';
import type { ChatMessage } from '@/core/types';
import type { MessageRenderer } from '@/features/chat/rendering/MessageRenderer';
import { getResponseSegments } from '@/features/chat/rendering/NotificationBoundaries';
import { providerOutputEventToStreamChunk } from '@/features/chat/rendering/providerOutputChunks';
import { hasResponseOutput, isStandaloneTaskNotification } from '@/features/chat/rendering/ResponseLayout';
import type { ChatState } from '@/features/chat/state/ChatState';
import {
  continueResponseAfterNotification,
  getTurnIdentity,
  markStoppedTurn,
  type StoppedTurnEvents,
} from '@/features/chat/turns/ResponseContinuation';
import type { StreamController } from '@/features/chat/turns/StreamController';
import type { TurnCoordinator } from '@/features/chat/turns/TurnCoordinator';

interface ResponseStreamHost {
  readonly state: ChatState;
  readonly renderer: MessageRenderer | null;
  readonly stream: StreamController;
  /** The turn whose streaming presentation this response ends. */
  readonly turns: Pick<TurnCoordinator, 'settle'>;
  createMessageId(): string;
}

/** Requested-response presentation, independent of durable or temporary conversation ownership. */
export class ResponseStream {
  #active: ChatMessage | null = null;
  /** The run's provider events up to its terminal, which a Stop's notifications must follow. */
  #received: StoppedTurnEvents | undefined;

  constructor(private readonly host: ResponseStreamHost) {}

  get active(): ChatMessage | null {
    return this.#active;
  }

  /** Starts a response message, in the native turn of the event that opened it when one did. */
  start(scope?: ProviderTurnEventScope): ChatMessage {
    const { state, renderer } = this.host;
    const message: ChatMessage = {
      id: this.host.createMessageId(), role: 'assistant', content: '', timestamp: Date.now(),
      toolCalls: [], contentBlocks: [], ...(scope ? { turnId: getTurnIdentity(scope) } : {}),
    };
    state.addMessage(message);
    this.#active = message;
    state.response.messageId = message.id;
    const element = renderer?.addMessage(message);
    const contentEl = element?.querySelector<HTMLElement>('.claudian-message-content') ?? null;
    state.currentContentEl = contentEl;
    state.currentTextEl = null;
    state.currentTextContent = '';
    state.currentThinkingBlock = null;
    state.currentThinkingState = null;
    return message;
  }

  clear(): void {
    this.#active = null;
    this.#received = undefined;
    this.host.state.response.messageId = null;
  }

  /** Records an event of the run, including the message boundaries the turn's owner handles itself. */
  observe(event: ProviderExecutionEvent): void {
    const assistant = this.#active;
    if (!assistant) return;
    if (event.type !== 'turn_completed' && event.type !== 'cancelled' && event.type !== 'execution_error') {
      this.#received = { scope: event.scope, through: event.scope.sequence };
    }
    // Each message takes the native turn of the events it renders, whichever message boundaries split it.
    assistant.turnId = getTurnIdentity(event.scope);
  }

  async handleEvent(event: ProviderExecutionEvent): Promise<void> {
    const assistant = this.#active;
    if (!assistant) return;
    this.observe(event);
    if (event.type === 'turn_completed') {
      assistant.turnStats = event.turnStats;
      return;
    }
    const chunk = providerOutputEventToStreamChunk(event);
    if (!chunk) return;
    this.#active = await continueResponseAfterNotification(this.host, assistant, chunk, event.scope);
    this.#active.turnId = assistant.turnId;
    await this.host.stream.handleStreamChunk(chunk, this.#active);
  }

  async flush(message: ChatMessage): Promise<void> {
    await this.host.stream.finalizeCurrentThinkingBlock(message);
    await this.host.stream.finalizeCurrentTextBlock(message);
  }

  async finish(message: ChatMessage, outcome: { interrupted: boolean; failed: boolean }): Promise<void> {
    const { state, renderer, stream } = this.host;
    state.clearFlavorTimerInterval();
    stream.thinkingIndicator.hide();
    let last = message;
    if (outcome.interrupted) {
      // Buffered text and thinking are output too, before the stop decides what the turn showed.
      await this.flush(message);
      // Segments of this response no event reached yet belong to the turn too.
      const turnId = message.turnId ?? (this.#received ? getTurnIdentity(this.#received.scope) : message.id);
      for (const segment of getResponseSegments(message, state.messages)) segment.turnId ??= turnId;
      const reply = this.#dropOutputFreeTail(message);
      const replyContentEl = reply === message ? state.currentContentEl : renderer?.getMessageContentEl(reply.id) ?? null;
      // A turn stopped before any output shows only the indicator, as replay renders it.
      if (!hasResponseOutput(reply)) replyContentEl?.empty();
      last = markStoppedTurn(renderer, reply, replyContentEl, state.messages, this.#received);
    }
    const successful = !outcome.interrupted && !outcome.failed;
    // Compaction continues the turn, so its time belongs to the completed response.
    if (successful && message.completedAt !== undefined) {
      message.durationSeconds = state.responseStartTime !== null
        ? Math.floor((performance.now() - state.responseStartTime) / 1000) : 0;
    }
    state.responseStartTime = null;
    this.host.turns.settle();
    state.currentContentEl = null;
    await this.flush(message);
    state.response.messageId = null;
    this.host.renderer?.finalizeResponse(last, state.messages, successful);
    stream.subagents.releaseManaged();
  }

  /**
   * A stopped turn ends at its last output, before the notifications it received: the
   * output-free messages a new boundary or blank output started after it show nothing
   * and are dropped. A turn with no output ends at its first message, the response's anchor.
   */
  #dropOutputFreeTail(message: ChatMessage): ChatMessage {
    const { state, renderer } = this.host;
    const tail: ChatMessage[] = [];
    let reply: ChatMessage | undefined;
    for (let index = state.messages.indexOf(message); index >= 0 && !reply; index--) {
      const item = state.messages[index];
      // The guard's false branch would narrow every message away.
      const notification: boolean = isStandaloneTaskNotification(item);
      if (notification) continue;
      if (item.role !== 'assistant' || item.turnId !== message.turnId) break;
      if (hasResponseOutput(item)) reply = item;
      else tail.push(item);
    }
    reply ??= tail.pop() ?? message;
    state.messages = state.messages.filter(candidate => !tail.includes(candidate));
    for (const dropped of tail) renderer?.removeMessage(dropped.id);
    return reply;
  }
}
