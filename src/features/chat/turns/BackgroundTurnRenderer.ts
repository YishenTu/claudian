import type { ProviderBackgroundEventScope, ProviderBackgroundOutputEvent, ProviderRequestedEventScope } from '@/core/execution';
import { TOOL_AGENT_OUTPUT } from '@/core/tools/toolNames';
import type { ChatMessage, StreamChunk } from '@/core/types';
import type { MessageRenderer } from '@/features/chat/rendering/MessageRenderer';
import { recordNotificationPredecessors, recordResponseContinuation } from '@/features/chat/rendering/NotificationBoundaries';
import { providerOutputEventToStreamChunk } from '@/features/chat/rendering/providerOutputChunks';
import { getAutomaticNotificationPredecessor, hasResponseOutput, isStandaloneTaskNotification } from '@/features/chat/rendering/ResponseLayout';
import type { ChatState } from '@/features/chat/state/ChatState';
import {
  continueResponseAfterNotification,
  getTrailingNotificationsEnd,
  getTurnIdentity,
  markStoppedTurn,
  type StoppedTurnEvents,
} from '@/features/chat/turns/ResponseContinuation';
import type { StreamController } from '@/features/chat/turns/StreamController';

export interface BackgroundTurnRenderHost {
  readonly state: ChatState;
  readonly renderer: MessageRenderer | null;
  readonly stream: StreamController;
  createMessageId(): string;
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
  const followArrival = host.renderer?.follow.holdArrival();
  const element = host.renderer?.addMessage(message) ?? null;
  const contentEl = element?.querySelector<HTMLElement>('.claudian-message-content');
  if (contentEl) host.renderer?.renderTaskNotification(contentEl, content);
  followArrival?.();
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
    case 'stop_hook':
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

/**
 * The stopped input span's last message carries the interrupt: its last reply, or a
 * notification that trailed it; a span without output keeps a bare marker after its
 * reserved position and trailing notifications, as replay records it. Returns the
 * message whose finalization folds the turn.
 */
function markInterruptedTurn(
  host: BackgroundTurnRenderHost,
  stopped: readonly ChatMessage[],
  anchor: ChatMessage | undefined,
  terminal: ProviderBackgroundEventScope,
): ChatMessage | undefined {
  const messages = host.state.messages;
  // Only notifications the turn received before it ended belong to it.
  const turn: StoppedTurnEvents = { scope: terminal, through: terminal.sequence - 1 };
  const reply = stopped.at(-1);
  if (!reply) {
    const marker: ChatMessage = {
      id: host.createMessageId(), role: 'assistant', content: '', timestamp: Date.now(), isInterrupt: true,
      turnId: getTurnIdentity(terminal),
    };
    const index = getTrailingNotificationsEnd(messages, anchor ? messages.indexOf(anchor) : -1, turn);
    messages.splice(index + 1, 0, marker);
    host.state.messages = messages;
    const contentEl = host.renderer?.addMessage(marker, messages[index]?.id).querySelector<HTMLElement>('.claudian-message-content');
    if (contentEl) host.renderer?.appendInterruptIndicator(contentEl);
    return undefined;
  }
  // The span is one native turn with no completion, like a stopped requested reply.
  for (const segment of stopped) {
    segment.turnId = getTurnIdentity(terminal);
    segment.completedAt = undefined;
  }
  return markStoppedTurn(host.renderer, reply, host.renderer?.getMessageContentEl(reply.id) ?? null, messages, turn);
}

interface BackgroundTurnSpan {
  /** The provider sequence of the input that opened this span; 0 for the turn's own start. */
  readonly afterSequence: number;
  readonly target: BackgroundTurnRenderTarget;
  readonly user?: ChatMessage;
}

/** The latest span to receive output; its segments start at `start` in the turn's segment list. */
interface SpanProgress {
  /** Closed spans have finalized blocks; only the last one can still carry a stop. */
  phase: 'open' | 'closed';
  readonly index: number;
  readonly start: number;
  /** The message before its reservation, where a stop without output leaves its marker. */
  readonly anchor: ChatMessage | undefined;
  message: ChatMessage;
  visible: boolean;
}

/**
 * Renders one native background turn as its output arrives, into replies reserved in transcript
 * order: each input boundary opens a span with its own reply. A reply stays hidden until its span
 * shows visible output; completion finalizes the replies and folds a stopped turn. The caller owns
 * event ordering, storage and execution lifetime.
 */
export class AutoTriggeredTurn {
  readonly #spans: BackgroundTurnSpan[];
  readonly #state: ChatState;
  readonly #stream: StreamController;
  readonly #segments: ChatMessage[] = [];
  readonly #hiddenToolIds = new Set<string>();
  #latest: SpanProgress | null = null;
  #isCurrent: () => boolean = () => true;

  constructor(private readonly host: BackgroundTurnRenderHost, target: BackgroundTurnRenderTarget) {
    this.#spans = [{ afterSequence: 0, target }];
    // An open prompt withholds this turn's waiting indicator, as it does a requested turn's.
    this.#state = host.state.createResponseState({
      onUsageChanged: usage => {
        if (this.#isCurrent() && !host.state.isStreaming) {
          if (usage) host.state.reportUsage(usage);
          else host.state.usage = null;
        }
      },
    });
    this.#state.currentConversationId = host.state.currentConversationId;
    this.#stream = host.stream.createBackgroundStream(this.#state);
  }

  /**
   * What the next input boundary follows: the latest span's last rendered segment, which may be a
   * continuation after a notification, else its reservation while its output is still queued.
   */
  get insertionAnchor(): ChatMessage {
    const last = this.#spans.length - 1;
    const latest = this.#latest?.index === last ? this.#latest : null;
    const messages = this.host.state.messages;
    return (latest && this.#segments.slice(latest.start).reverse().find(segment => messages.includes(segment)))
      || this.#spans[last].target.message;
  }

  get hasUserMessages(): boolean {
    return this.#spans.some(span => span.user !== undefined);
  }

  /** Opens a span for input the provider accepted after `afterSequence`, with its reserved reply. */
  addSpan(afterSequence: number, user: ChatMessage, target: BackgroundTurnRenderTarget): void {
    this.#spans.push({ afterSequence, user, target });
  }

  /** Renders one output event; the caller delivers events in provider sequence. */
  async push(event: ProviderBackgroundOutputEvent, isCurrent: () => boolean): Promise<void> {
    this.#isCurrent = isCurrent;
    const chunk = providerOutputEventToStreamChunk(event);
    if (!chunk || !isCurrent()) return;
    const index = this.#spans.findLastIndex(span => span.afterSequence < event.scope.sequence);
    if (!await this.#openThrough(Math.max(index, 0))) return;
    const span = this.#latest!;
    if (chunk.type === 'tool_use' && chunk.name === TOOL_AGENT_OUTPUT) this.#hiddenToolIds.add(chunk.id);
    // Every chunk picks its segment first: whitespace that starts a reply after a notification is that reply's.
    const continuation = await continueResponseAfterNotification({
      state: this.host.state, streamState: this.#state, renderer: this.host.renderer, stream: this.#stream,
      createMessageId: () => this.host.createMessageId(), isCurrent,
    }, span.message, chunk, event.scope);
    if (!isCurrent()) return;
    if (continuation !== span.message) {
      span.message = continuation;
      this.#segments.push(continuation);
      if (!span.visible) this.#setSpanHidden(span, true);
    }
    if (!span.visible && isVisibleAutoTurnChunk(chunk, this.#hiddenToolIds)) {
      span.visible = true;
      // Showing the reply is its arrival; later growth follows as the reader's follow setting allows.
      const followArrival = this.host.renderer?.follow.holdArrival();
      this.#setSpanHidden(span, false);
      followArrival?.();
    }
    this.#state.messages = this.host.state.messages;
    await this.#stream.handleStreamChunk(chunk, span.message);
  }

  /** Finalizes every span, then folds a stopped turn; returns whether the turn left anything visible. */
  async complete(
    metadata: { assistantMessageId?: string },
    interruptedAt: ProviderBackgroundEventScope | undefined,
    isCurrent: () => boolean,
  ): Promise<boolean> {
    this.#isCurrent = isCurrent;
    const host = this.host;
    if (!isCurrent()) {
      this.#release();
      return false;
    }
    // Completion settles every reply as one arrival, measured on the presentation it started in.
    const followArrival = host.renderer?.follow.holdArrival();
    try {
      if (!await this.#openThrough(this.#spans.length - 1) || !await this.#closeOpen()) return false;
      const final = this.#latest!;
      let checkpointMessage = this.#segments.slice(final.start).reverse().find(segment => host.state.messages.includes(segment));
      if (interruptedAt) {
        // A stopped span ends at its output: output-free segments on either side of its notifications show nothing.
        const empty = this.#segments.slice(final.start).filter(segment => !hasResponseOutput(segment));
        host.state.messages = host.state.messages.filter(message => !empty.includes(message));
        for (const segment of empty) host.renderer?.removeMessage(segment.id);
        checkpointMessage = this.#segments.slice(final.start).reverse().find(segment => host.state.messages.includes(segment));
      }
      const visible = this.#segments.filter(segment => host.state.messages.includes(segment));
      if (checkpointMessage && metadata.assistantMessageId) checkpointMessage.assistantMessageId = metadata.assistantMessageId;
      const stopped = interruptedAt ? this.#segments.slice(final.start).filter(segment => visible.includes(segment)) : [];
      const owner = interruptedAt ? markInterruptedTurn(host, stopped, final.anchor, interruptedAt) : undefined;
      for (const segment of visible) {
        if (stopped.includes(segment)) continue;
        const previous = getAutomaticNotificationPredecessor(segment, host.state.messages);
        // Include only notification context, never another response's live work.
        host.renderer?.finalizeResponse(segment, previous ? [previous, segment] : [segment]);
      }
      // The stopped span folds once, from its owner; the shared layout bounds it.
      if (owner) host.renderer?.finalizeResponse(owner, host.state.messages);
      return visible.length > 0 || interruptedAt !== undefined;
    } finally {
      this.#release();
      followArrival?.();
    }
  }

  /** Removes everything this turn reserved or rendered, for a transcript that no longer accepts it. */
  discard(): void {
    this.#release();
    const owned = this.#ownedMessages();
    for (const message of owned) this.host.renderer?.removeMessage(message.id);
    this.host.state.messages = this.host.state.messages.filter(message => !owned.has(message));
  }

  #release(): void {
    this.#stream.dispose();
    this.#state.dispose();
  }

  /** A span's segments stay hidden together until it shows visible output. */
  #setSpanHidden(span: SpanProgress, hidden: boolean): void {
    for (const segment of this.#segments.slice(span.start)) {
      const element = this.host.renderer?.getMessageContentEl(segment.id)?.parentElement;
      if (element) element.hidden = hidden;
    }
  }

  /** Where this turn's first message sits in `messages`, or -1 when none of it is there. */
  transcriptStart(messages: readonly ChatMessage[]): number {
    const owned = this.#ownedMessages();
    return messages.findIndex(message => owned.has(message));
  }

  /** Everything this turn reserved or rendered: replies, continuations and steered input. */
  #ownedMessages(): Set<ChatMessage> {
    return new Set([...this.#segments, ...this.#spans.flatMap(span => span.user ? [span.target.message, span.user] : [span.target.message])]);
  }

  /** Closes open spans before `index` in order, so output-free input boundaries settle as they did. */
  async #openThrough(index: number): Promise<boolean> {
    if (this.#latest?.phase === 'open' && this.#latest.index >= index) return true;
    if (!await this.#closeOpen()) return false;
    for (let next = (this.#latest?.index ?? -1) + 1; next <= index; next++) {
      this.#begin(next);
      if (next < index && !await this.#closeOpen()) return false;
    }
    return true;
  }

  #begin(index: number): void {
    const { target } = this.#spans[index];
    const messages = this.host.state.messages;
    const reserved = messages.indexOf(target.message);
    this.#latest = {
      phase: 'open', index, start: this.#segments.length, message: target.message, visible: false,
      anchor: reserved > 0 ? messages[reserved - 1] : reserved < 0 ? messages.at(-1) : undefined,
    };
    this.#segments.push(target.message);
    this.#state.response.messageId = target.message.id;
    this.#state.currentContentEl = this.host.renderer?.getMessageContentEl(target.message.id) ?? null;
  }

  /** Finalizes the open span's blocks; a span that never showed output gives up its reply. */
  async #closeOpen(): Promise<boolean> {
    const span = this.#latest;
    if (span?.phase !== 'open') return true;
    const { host } = this;
    const stream = this.#stream;
    const message = span.message;
    span.phase = 'closed';
    await stream.handleStreamChunk({ type: 'done' }, message);
    await stream.finalizeCurrentThinkingBlock(message);
    if (!this.#isCurrent()) return false;
    await stream.finalizeCurrentTextBlock(message);
    if (!this.#isCurrent()) return false;
    stream.thinkingIndicator.hide();
    message.completedAt = Date.now();
    if (!span.visible) {
      for (const segment of this.#segments.slice(span.start)) discardBackgroundTurn(host, { message: segment });
    } else if (!hasResponseOutput(message) && host.state.messages.includes(message)) {
      host.state.messages = host.state.messages.filter(item => item !== message);
      host.renderer?.removeMessage(message.id);
    }
    this.#state.currentContentEl = null;
    return true;
  }
}
