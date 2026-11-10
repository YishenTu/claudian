import type { UsageInfo } from '@/core/types';
import { cleanupThinkingBlock } from '@/features/chat/rendering/ThinkingBlockRenderer';
import { ResponseModel } from '@/features/chat/state/ResponseModel';
import { SessionAttention } from '@/features/chat/state/SessionAttention';
import type {
  ChatActivity,
  ChatMessage,
  ChatStateCallbacks,
  ChatStateData,
  PendingToolCall,
  QueuedMessage,
  StreamingThinkingBlock,
  TabAttention,
  TabReviewOutcome,
  ThinkingBlockState,
  TurnActivity,
  WriteEditState,
} from '@/features/chat/state/types';
import { mergeReportedUsage } from '@/features/chat/state/usageInfo';

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
    isRewinding: false,
    currentConversationId: null,
    queuedMessage: null,
    currentContentEl: null,
    currentTextEl: null,
    currentThinkingState: null,
    queueIndicatorEl: null,
    toolCallElements: new Map(),
    writeEditStates: new Map(),
    pendingTools: new Map(),
    usage: null,
  };
}

export class ChatState {
  readonly response = new ResponseModel();
  private state: ChatStateData;
  private _callbacks: ChatStateCallbacks;
  private readonly subscriptions: Array<() => void> = [];
  /** Null derives activity from the latest message after transcript changes. */
  #activity: ChatActivity | null = null;
  #waitingStatus: string | null = null;
  readonly #activityListeners = new Set<() => void>();

  #conversationRevision = 0;
  #savedConversationRevision = 0;
  #wasStreaming = false;
  #queuedMessageClaimed = false;
  #transitionWriterClaimed = false;

  constructor(
    callbacks: ChatStateCallbacks = {},
    private readonly conversationIdentity?: { get(): string | null; set(id: string | null): void },
    /** The single owner of foreground turn state; presentation only derives from it. */
    private readonly turnActivity: TurnActivity = NO_TURN_ACTIVITY,
    private readonly sessionAttention = new SessionAttention(),
  ) {
    this.state = createInitialState();
    this._callbacks = callbacks;
    this.subscriptions.push(turnActivity.subscribe(() => this.#onTurnActivityChanged()));
    this.subscriptions.push(sessionAttention.subscribe(() => {
      this._callbacks.onAttentionChanged?.(sessionAttention.attention);
      this.#notifyActivity();
    }));
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

  get isRewinding(): boolean {
    return this.state.isRewinding;
  }

  /** ConversationController is the only writer of navigation transition state. */
  claimTransitionWriter(): (key: 'isRewinding', value: boolean) => void {
    if (this.#transitionWriterClaimed) throw new Error('Conversation transitions already have an owner.');
    this.#transitionWriterClaimed = true;
    return (key, value) => {
      this.state[key] = value;
      if (key === 'isRewinding') this._callbacks.onRewindingStateChanged?.(value);
    };
  }

  /** Local tab state is ahead of persisted conversation metadata. */
  get hasPendingConversationSave(): boolean {
    return this.#conversationRevision !== this.#savedConversationRevision;
  }

  markConversationDirty(): void {
    this.#conversationRevision += 1;
  }

  /** The revision a save's snapshot covers; capture it before reading the state to write. */
  get conversationRevision(): number {
    return this.#conversationRevision;
  }

  /** Clears pending changes up to `revision`; later changes stay pending for the next save. */
  markConversationSaved(revision: number): void {
    this.#savedConversationRevision = Math.max(this.#savedConversationRevision, revision);
  }

  /** The tab state now matches storage, such as after loading or resetting it. */
  discardPendingConversationSave(): void {
    this.#savedConversationRevision = this.#conversationRevision;
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
    return this.response.text;
  }

  set currentTextContent(value: string) {
    this.response.text = value;
  }

  get currentThinkingBlock(): StreamingThinkingBlock | null {
    return this.response.thinking;
  }

  set currentThinkingBlock(value: StreamingThinkingBlock | null) {
    this.response.thinking = value;
  }

  get currentThinkingState(): ThinkingBlockState | null {
    return this.state.currentThinkingState;
  }

  set currentThinkingState(value: ThinkingBlockState | null) {
    this.state.currentThinkingState = value;
  }

  get queueIndicatorEl(): HTMLElement | null {
    return this.state.queueIndicatorEl;
  }

  set queueIndicatorEl(value: HTMLElement | null) {
    this.state.queueIndicatorEl = value;
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

  get attention(): TabAttention { return this.sessionAttention.attention; }
  get requiresAction(): boolean { return this.sessionAttention.requiresAction; }
  get reviewEpoch(): number { return this.sessionAttention.reviewEpoch; }
  setActionRequired(required: boolean): void { this.sessionAttention.setActionRequired(required); }
  markReviewRequired(outcome: TabReviewOutcome = 'completed'): void { this.sessionAttention.markReviewRequired(outcome); }
  acknowledgeReview(): void { this.sessionAttention.acknowledgeReview(); }

  // ============================================
  // Response Timer State
  // ============================================

  get responseStartTime(): number | null {
    return this.response.startedAt;
  }

  set responseStartTime(value: number | null) {
    this.response.startedAt = value;
  }

  // ============================================
  // Reset Methods
  // ============================================

  dispose(): void {
    this.detachPresentation();
    for (const unsubscribe of this.subscriptions.splice(0)) unsubscribe();
    this.#activityListeners.clear();
  }

  /** Releases the current view without ending or discarding an open response. */
  detachPresentation(): void {
    cleanupThinkingBlock(this.currentThinkingState);
    this.currentContentEl = null;
    this.currentTextEl = null;
    this.currentThinkingState = null;
    this.queueIndicatorEl = null;
    this.toolCallElements.clear();
    this.writeEditStates.clear();
    this.pendingTools.clear();
  }

  resetStreamingPresentation(): void {
    this.response.reset();
    cleanupThinkingBlock(this.currentThinkingState);
    this.currentContentEl = null;
    this.currentTextEl = null;
    this.currentTextContent = '';
    this.currentThinkingBlock = null;
    this.currentThinkingState = null;
    this.responseStartTime = null;
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

}
