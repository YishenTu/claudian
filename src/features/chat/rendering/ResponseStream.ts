import type { ProviderExecutionEvent } from '@/core/execution';
import type { ChatMessage } from '@/core/types';

import { providerOutputEventToStreamChunk, type StreamController } from '../controllers/StreamController';
import type { TurnCoordinator } from '../controllers/TurnCoordinator';
import type { ChatState } from '../state/ChatState';
import type { MessageRenderer } from './MessageRenderer';
import { continueResponseAfterNotification } from './ResponseContinuation';

interface ResponseStreamHost {
  readonly state: ChatState;
  readonly renderer: MessageRenderer;
  readonly stream: StreamController;
  /** The turn whose streaming presentation this response ends. */
  readonly turns: Pick<TurnCoordinator, 'settle'>;
  createMessageId(): string;
}

/** Requested-response presentation, independent of durable or temporary conversation ownership. */
export class ResponseStream {
  #active: ChatMessage | null = null;

  constructor(private readonly host: ResponseStreamHost) {}

  get active(): ChatMessage | null {
    return this.#active;
  }

  start(): ChatMessage {
    const { state, renderer } = this.host;
    const message: ChatMessage = {
      id: this.host.createMessageId(), role: 'assistant', content: '', timestamp: Date.now(),
      toolCalls: [], contentBlocks: [],
    };
    state.addMessage(message);
    this.#active = message;
    const element = renderer.addMessage(message);
    const contentEl = element.querySelector<HTMLElement>('.claudian-message-content');
    if (contentEl) {
      if (!state.currentContentEl) state.toolCallElements.clear();
      state.currentContentEl = contentEl;
      state.currentTextEl = null;
      state.currentTextContent = '';
      state.currentThinkingState = null;
    }
    return message;
  }

  clear(): void {
    this.#active = null;
  }

  async handleEvent(event: ProviderExecutionEvent): Promise<void> {
    const assistant = this.#active;
    if (!assistant) return;
    if (event.type === 'turn_completed') {
      assistant.turnStats = event.turnStats;
      return;
    }
    const chunk = providerOutputEventToStreamChunk(event);
    if (!chunk) return;
    this.#active = await continueResponseAfterNotification(this.host, assistant, chunk, event.scope);
    await this.host.stream.handleStreamChunk(chunk, this.#active);
  }

  async flush(message: ChatMessage): Promise<void> {
    await this.host.stream.finalizeCurrentThinkingBlock(message);
    await this.host.stream.finalizeCurrentTextBlock(message);
  }

  async finish(message: ChatMessage, outcome: { interrupted: boolean; failed: boolean }): Promise<void> {
    const { state, renderer, stream } = this.host;
    state.clearFlavorTimerInterval();
    stream.hideThinkingIndicator();
    if (outcome.interrupted) {
      message.isInterrupt = true;
      if (state.currentContentEl) renderer.appendInterruptIndicator(state.currentContentEl);
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
    renderer.finalizeResponse(message, state.messages, successful);
    stream.resetSubagentStreamingState();
  }
}
