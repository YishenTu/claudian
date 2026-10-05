import type { UsageInfo } from '@/core/types';
import { cleanupThinkingBlock } from '@/features/chat/rendering/ThinkingBlockRenderer';
import type {
  ChatActivity,
  ChatMessage,
  ChatStateCallbacks,
  ChatStateData,
  PendingToolCall,
  QueuedMessage,
  TabAttention,
  TabReviewOutcome,
  ThinkingBlockState,
  WriteEditState,
} from '@/features/chat/state/types';
import { mergeReportedUsage } from '@/features/chat/state/usageInfo';
import type { TurnActivity } from '@/features/chat/turns/TurnCoordinator';

/** Presentation without a foreground turn owner, such as replayed background output. */
const NO_TURN_ACTIVITY: TurnActivity = Object.freeze({
  isInFlight: false,
  cancelRequested: false,
  streamGeneration: 0,
  subscribe: () => () => undefined,
});

function createInitialState(): ChatStateData {
  return {
    messages: [],
    isResettingToNewChat: false,
    isSwitchingConversation: false,
    isRewinding: false,
    hasPendingConversationSave: false,
    currentConversationId: null,
    queuedMessage: null,
    currentContentEl: null,
    currentTextEl: null,
    currentTextContent: '',
    currentThinkingState: null,
    thinkingEl: null,
    queueIndicatorEl: null,
    thinkingIndicatorTimeout: null,
    toolCallElements: new Map(),
    writeEditStates: new Map(),
    pendingTools: new Map(),
    usage: null,
    attention: null,
    autoScrollEnabled: true, // Default; controllers will override based on settings
    responseStartTime: null,
    flavorTimerInterval: null,
  };
}

export class ChatState {
  private state: ChatStateData;
  private _callbacks: ChatStateCallbacks;
  private readonly pendingActionIds = new Set<string>();
  private pendingReview: {
    outcome: TabReviewOutcome;
    since: number;
  } | null = null;
  /** Null derives activity from the latest message after transcript changes. */
  #activity: ChatActivity | null = null;
  #waitingStatus: string | null = null;
  readonly #activityListeners = new Set<() => void>();
  /** Last transcript scroll offset seen while laid out; a hidden scroller reports zero. */
  readingScrollTop = 0;
  private thinkingIndicatorTimeoutWindow: Window | null = null;
  private flavorTimerIntervalWindow: Window | null = null;

  #wasStreaming = false;
  #queuedMessageClaimed = false;
  #transitionWriterClaimed = false;

  constructor(
    callbacks: ChatStateCallbacks = {},
    private readonly conversationIdentity?: { get(): string | null; set(id: string | null): void },
    /** The single owner of foreground turn state; presentation only derives from it. */
    private readonly turnActivity: TurnActivity = NO_TURN_ACTIVITY,
  ) {
    this.state = createInitialState();
    this._callbacks = callbacks;
    turnActivity.subscribe(() => this.#onTurnActivityChanged());
  }

  // ============================================
  // Messages
  // ============================================

  get messages(): ChatMessage[] {
    return [...this.state.messages];
  }

  set messages(value: ChatMessage[]) {
    this.state.messages = value;
    this.#resetActivity();
  }

  get lastMessage(): ChatMessage | null {
    return this.state.messages.at(-1) ?? null;
  }

  addMessage(msg: ChatMessage): void {
    this.state.messages.push(msg);
    // A new response shell keeps the submitted prompt visible until output arrives.
    if (msg.role === 'user') this.recordActivity({ kind: 'user', text: msg.displayContent ?? msg.content });
    else if (this.#activity?.kind !== 'user') this.#resetActivity();
  }

  clearMessages(): void {
    this.state.messages = [];
    this.#resetActivity();
  }

  truncateAt(messageId: string): number {
    const idx = this.state.messages.findIndex(m => m.id === messageId);
    if (idx === -1) return 0;
    const removed = this.state.messages.length - idx;
    this.state.messages = this.state.messages.slice(0, idx);
    this.#resetActivity();
    return removed;
  }

  // ============================================
  // Runtime-only Activity
  // ============================================

  get activity(): ChatActivity | null {
    return this.#activity;
  }

  recordActivity(activity: ChatActivity): void {
    this.#activity = activity;
    this.#notifyActivity();
  }

  /** Label of the visible waiting indicator, so other presentations can mirror it. */
  get waitingStatus(): string | null {
    return this.#waitingStatus;
  }

  set waitingStatus(value: string | null) {
    if (value === this.#waitingStatus) return;
    this.#waitingStatus = value;
    this.#notifyActivity();
  }

  /** Listeners must stay cheap; they run for every recorded chunk. */
  subscribeActivity(listener: () => void): () => void {
    this.#activityListeners.add(listener);
    return () => {
      this.#activityListeners.delete(listener);
    };
  }

  // ============================================
  // Streaming Control
  // ============================================

  /** Derived from the turn owner: a response is admitted and not yet settled. */
  get isStreaming(): boolean {
    return this.turnActivity.isInFlight;
  }

  get cancelRequested(): boolean {
    return this.turnActivity.cancelRequested;
  }

  get streamGeneration(): number {
    return this.turnActivity.streamGeneration;
  }

  get isResettingToNewChat(): boolean {
    return this.state.isResettingToNewChat;
  }

  get isSwitchingConversation(): boolean {
    return this.state.isSwitchingConversation;
  }

  get isRewinding(): boolean {
    return this.state.isRewinding;
  }

  /** ConversationController is the only writer of navigation transition state. */
  claimTransitionWriter(): (key: 'isResettingToNewChat' | 'isSwitchingConversation' | 'isRewinding', value: boolean) => void {
    if (this.#transitionWriterClaimed) throw new Error('Conversation transitions already have an owner.');
    this.#transitionWriterClaimed = true;
    return (key, value) => {
      this.state[key] = value;
      if (key === 'isRewinding') this._callbacks.onRewindingStateChanged?.(value);
    };
  }

  get hasPendingConversationSave(): boolean {
    return this.state.hasPendingConversationSave;
  }

  set hasPendingConversationSave(value: boolean) {
    this.state.hasPendingConversationSave = value;
  }

  // ============================================
  // Conversation
  // ============================================

  get currentConversationId(): string | null {
    return this.conversationIdentity ? this.conversationIdentity.get() : this.state.currentConversationId;
  }

  set currentConversationId(value: string | null) {
    if (this.conversationIdentity) this.conversationIdentity.set(value);
    else this.state.currentConversationId = value;
    this._callbacks.onConversationChanged?.(value);
  }

  // ============================================
  // Queued Message
  // ============================================

  get queuedMessage(): QueuedMessage | null {
    return this.state.queuedMessage;
  }

  /** The tab's turn queue is the single writer; a second claim is a wiring error. */
  claimQueuedMessageWriter(): (value: QueuedMessage | null) => void {
    if (this.#queuedMessageClaimed) throw new Error('The queued message already has an owner.');
    this.#queuedMessageClaimed = true;
    return value => { this.state.queuedMessage = value; };
  }

  // ============================================
  // Streaming DOM State
  // ============================================

  get currentContentEl(): HTMLElement | null {
    return this.state.currentContentEl;
  }

  set currentContentEl(value: HTMLElement | null) {
    this.state.currentContentEl = value;
  }

  get currentTextEl(): HTMLElement | null {
    return this.state.currentTextEl;
  }

  set currentTextEl(value: HTMLElement | null) {
    this.state.currentTextEl = value;
  }

  get currentTextContent(): string {
    return this.state.currentTextContent;
  }

  set currentTextContent(value: string) {
    this.state.currentTextContent = value;
  }

  get currentThinkingState(): ThinkingBlockState | null {
    return this.state.currentThinkingState;
  }

  set currentThinkingState(value: ThinkingBlockState | null) {
    this.state.currentThinkingState = value;
  }

  get thinkingEl(): HTMLElement | null {
    return this.state.thinkingEl;
  }

  set thinkingEl(value: HTMLElement | null) {
    this.state.thinkingEl = value;
  }

  get queueIndicatorEl(): HTMLElement | null {
    return this.state.queueIndicatorEl;
  }

  set queueIndicatorEl(value: HTMLElement | null) {
    this.state.queueIndicatorEl = value;
  }

  get thinkingIndicatorTimeout(): number | null {
    return this.state.thinkingIndicatorTimeout;
  }

  // ============================================
  // Tool Tracking Maps (mutable references)
  // ============================================

  get toolCallElements(): Map<string, HTMLElement> {
    return this.state.toolCallElements;
  }

  get writeEditStates(): Map<string, WriteEditState> {
    return this.state.writeEditStates;
  }

  get pendingTools(): Map<string, PendingToolCall> {
    return this.state.pendingTools;
  }

  // ============================================
  // Usage State
  // ============================================

  get usage(): UsageInfo | null {
    return this.state.usage;
  }

  set usage(value: UsageInfo | null) {
    this.state.usage = value;
    this._callbacks.onUsageChanged?.(value);
  }

  reportUsage(next: UsageInfo): void {
    this.usage = mergeReportedUsage(this.usage, next);
  }

  // ============================================
  // Runtime-only Attention State
  // ============================================

  get attention(): TabAttention {
    return this.state.attention;
  }

  get requiresAction(): boolean {
    return this.state.attention?.kind === 'action-required';
  }

  beginActionRequired(interactionId: string): void {
    if (this.pendingActionIds.has(interactionId)) return;

    this.pendingActionIds.add(interactionId);
    if (this.state.attention?.kind === 'review' && this.pendingReview === null) {
      this.pendingReview = {
        outcome: this.state.attention.outcome,
        since: this.state.attention.since,
      };
    }
    if (!this.requiresAction) {
      this.#setAttention({ kind: 'action-required', since: Date.now() });
    }
  }

  endActionRequired(interactionId: string): void {
    if (!this.pendingActionIds.delete(interactionId)) return;
    if (this.pendingActionIds.size === 0 && this.requiresAction) {
      const review = this.pendingReview;
      this.pendingReview = null;
      this.#setAttention(review === null
        ? null
        : { kind: 'review', ...review });
    }
  }

  markReviewRequired(outcome: TabReviewOutcome = 'completed'): void {
    if (this.state.attention?.kind === 'review') {
      if (this.state.attention.outcome === 'error' || outcome === 'completed') return;
      this.#setAttention({
        kind: 'review',
        outcome: 'error',
        since: this.state.attention.since,
      });
      return;
    }
    if (this.requiresAction) {
      if (this.pendingReview === null) {
        this.pendingReview = { outcome, since: Date.now() };
      } else if (outcome === 'error') {
        this.pendingReview.outcome = 'error';
      }
      return;
    }
    this.#setAttention({ kind: 'review', outcome, since: Date.now() });
  }

  acknowledgeReview(): void {
    this.pendingReview = null;
    if (this.state.attention?.kind === 'review') {
      this.#setAttention(null);
    }
  }

  // ============================================
  // Auto-Scroll Control
  // ============================================

  get autoScrollEnabled(): boolean {
    return this.state.autoScrollEnabled;
  }

  set autoScrollEnabled(value: boolean) {
    const changed = this.state.autoScrollEnabled !== value;
    this.state.autoScrollEnabled = value;
    if (changed) {
      this._callbacks.onAutoScrollChanged?.(value);
    }
  }

  // ============================================
  // Response Timer State
  // ============================================

  get responseStartTime(): number | null {
    return this.state.responseStartTime;
  }

  set responseStartTime(value: number | null) {
    this.state.responseStartTime = value;
  }

  get flavorTimerInterval(): number | null {
    return this.state.flavorTimerInterval;
  }

  // ============================================
  // Reset Methods
  // ============================================

  resetStreamingPresentation(): void {
    cleanupThinkingBlock(this.currentThinkingState);
    this.currentContentEl = null;
    this.currentTextEl = null;
    this.currentTextContent = '';
    this.currentThinkingState = null;
    this.responseStartTime = null;
  }

  setThinkingIndicatorTimeout(value: number | null, ownerWindow: Window | null): void {
    this.state.thinkingIndicatorTimeout = value;
    this.thinkingIndicatorTimeoutWindow = value === null ? null : ownerWindow;
  }

  clearThinkingIndicatorTimeout(fallbackWindow: Window | null = null): void {
    if (this.state.thinkingIndicatorTimeout) {
      const ownerWindow = this.thinkingIndicatorTimeoutWindow ?? fallbackWindow ?? this.#getDefaultTimerWindow();
      ownerWindow?.clearTimeout(this.state.thinkingIndicatorTimeout);
      this.state.thinkingIndicatorTimeout = null;
      this.thinkingIndicatorTimeoutWindow = null;
    }
  }

  setFlavorTimerInterval(value: number | null, ownerWindow: Window | null): void {
    this.state.flavorTimerInterval = value;
    this.flavorTimerIntervalWindow = value === null ? null : ownerWindow;
  }

  clearFlavorTimerInterval(): void {
    if (this.state.flavorTimerInterval) {
      const ownerWindow = this.flavorTimerIntervalWindow ?? this.#getDefaultTimerWindow();
      ownerWindow?.clearInterval(this.state.flavorTimerInterval);
      this.state.flavorTimerInterval = null;
      this.flavorTimerIntervalWindow = null;
    }
  }

  #onTurnActivityChanged(): void {
    const isStreaming = this.isStreaming;
    if (isStreaming === this.#wasStreaming) return;
    this.#wasStreaming = isStreaming;
    this._callbacks.onStreamingStateChanged?.(isStreaming);
    this.#notifyActivity();
  }

  #resetActivity(): void {
    this.#activity = null;
    this.#notifyActivity();
  }

  #notifyActivity(): void {
    for (const listener of this.#activityListeners) listener();
  }

  #getDefaultTimerWindow(): Window | null {
    return typeof window === 'undefined' ? null : window;
  }

  #setAttention(attention: TabAttention): void {
    const current = this.state.attention;
    if (
      current === attention
      || (current !== null
        && attention !== null
        && current.kind === attention.kind
        && current.since === attention.since
        && (current.kind !== 'review'
          || attention.kind !== 'review'
          || current.outcome === attention.outcome))
    ) {
      return;
    }

    this.state.attention = attention;
    this._callbacks.onAttentionChanged?.(attention);
    this.#notifyActivity();
  }
}
