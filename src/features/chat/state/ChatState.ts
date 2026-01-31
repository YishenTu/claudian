import type { UsageInfo } from '../../../core/types';
import type {
  ChatMessage,
  ChatStateCallbacks,
  ChatStateData,
  PendingToolCall,
  PermissionMode,
  QueuedMessage,
  ThinkingBlockState,
  TodoItem,
  WriteEditState,
} from './types';

function createInitialState(): ChatStateData {
  return {
    messages: [],
    isStreaming: false,
    cancelRequested: false,
    streamGeneration: 0,
    isCreatingConversation: false,
    isSwitchingConversation: false,
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
    ignoreUsageUpdates: false,
    currentTodos: null,
    needsAttention: false,
    autoScrollEnabled: true, // Default; controllers will override based on settings
    responseStartTime: null,
    flavorTimerInterval: null,
    pendingNewSessionPlan: null,
    planFilePath: null,
    prePlanPermissionMode: null,
  };
}

export class ChatState {
  private state: ChatStateData;
  private _callbacks: ChatStateCallbacks;

  constructor(callbacks: ChatStateCallbacks = {}) {
    this.state = createInitialState();
    this._callbacks = callbacks;
  }

  get callbacks(): ChatStateCallbacks {
    return this._callbacks;
  }

  set callbacks(value: ChatStateCallbacks) {
    this._callbacks = value;
  }

  // ============================================
  // Messages
  // ============================================

  get messages(): ChatMessage[] {
    return [...this.state.messages];
  }

  set messages(value: ChatMessage[]) {
    this.state.messages = value;
    this._callbacks.onMessagesChanged?.();
  }

  addMessage(msg: ChatMessage): void {
    this.state.messages.push(msg);
    this._callbacks.onMessagesChanged?.();
  }

  clearMessages(): void {
    this.state.messages = [];
    this._callbacks.onMessagesChanged?.();
  }

  truncateAt(messageId: string): number {
    const idx = this.state.messages.findIndex(m => m.id === messageId);
    if (idx === -1) return 0;
    const removed = this.state.messages.length - idx;
    this.state.messages = this.state.messages.slice(0, idx);
    this._callbacks.onMessagesChanged?.();
    return removed;
  }

  // ============================================
  // Streaming Control
  // ============================================

  get isStreaming(): boolean {
    return this.state.isStreaming;
  }

  set isStreaming(value: boolean) {
    this.state.isStreaming = value;
    this._callbacks.onStreamingStateChanged?.(value);
  }

  get cancelRequested(): boolean {
    return this.state.cancelRequested;
  }

  set cancelRequested(value: boolean) {
    this.state.cancelRequested = value;
  }

  get streamGeneration(): number {
    return this.state.streamGeneration;
  }

  bumpStreamGeneration(): number {
    this.state.streamGeneration += 1;
    return this.state.streamGeneration;
  }

  get isCreatingConversation(): boolean {
    return this.state.isCreatingConversation;
  }

  set isCreatingConversation(value: boolean) {
    this.state.isCreatingConversation = value;
  }

  get isSwitchingConversation(): boolean {
    return this.state.isSwitchingConversation;
  }

  set isSwitchingConversation(value: boolean) {
    this.state.isSwitchingConversation = value;
  }

  // ============================================
  // Conversation
  // ============================================

  get currentConversationId(): string | null {
    return this.state.currentConversationId;
  }

  set currentConversationId(value: string | null) {
    this.state.currentConversationId = value;
    this._callbacks.onConversationChanged?.(value);
  }

  // ============================================
  // Queued Message
  // ============================================

  get queuedMessage(): QueuedMessage | null {
    return this.state.queuedMessage;
  }

  set queuedMessage(value: QueuedMessage | null) {
    this.state.queuedMessage = value;
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

  get thinkingIndicatorTimeout(): ReturnType<typeof setTimeout> | null {
    return this.state.thinkingIndicatorTimeout;
  }

  set thinkingIndicatorTimeout(value: ReturnType<typeof setTimeout> | null) {
    this.state.thinkingIndicatorTimeout = value;
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

  get ignoreUsageUpdates(): boolean {
    return this.state.ignoreUsageUpdates;
  }

  set ignoreUsageUpdates(value: boolean) {
    this.state.ignoreUsageUpdates = value;
  }

  // ============================================
  // Current Todos (for persistent bottom panel)
  // ============================================

  get currentTodos(): TodoItem[] | null {
    return this.state.currentTodos ? [...this.state.currentTodos] : null;
  }

  set currentTodos(value: TodoItem[] | null) {
    // Normalize empty arrays to null for consistency
    const normalizedValue = (value && value.length > 0) ? value : null;
    this.state.currentTodos = normalizedValue;
    this._callbacks.onTodosChanged?.(normalizedValue);
  }

  // ============================================
  // Attention State (approval pending, error, etc.)
  // ============================================

  get needsAttention(): boolean {
    return this.state.needsAttention;
  }

  set needsAttention(value: boolean) {
    this.state.needsAttention = value;
    this._callbacks.onAttentionChanged?.(value);
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

  get flavorTimerInterval(): ReturnType<typeof setInterval> | null {
    return this.state.flavorTimerInterval;
  }

  set flavorTimerInterval(value: ReturnType<typeof setInterval> | null) {
    this.state.flavorTimerInterval = value;
  }

  get pendingNewSessionPlan(): string | null {
    return this.state.pendingNewSessionPlan;
  }

  set pendingNewSessionPlan(value: string | null) {
    this.state.pendingNewSessionPlan = value;
  }

  get planFilePath(): string | null {
    return this.state.planFilePath;
  }

  set planFilePath(value: string | null) {
    this.state.planFilePath = value;
  }

  get prePlanPermissionMode(): PermissionMode | null {
    return this.state.prePlanPermissionMode;
  }

  set prePlanPermissionMode(value: PermissionMode | null) {
    this.state.prePlanPermissionMode = value;
  }

  // ============================================
  // Reset Methods
  // ============================================

  clearFlavorTimerInterval(): void {
    if (this.state.flavorTimerInterval) {
      clearInterval(this.state.flavorTimerInterval);
      this.state.flavorTimerInterval = null;
    }
  }

  resetStreamingState(): void {
    this.state.currentContentEl = null;
    this.state.currentTextEl = null;
    this.state.currentTextContent = '';
    this.state.currentThinkingState = null;
    this.state.isStreaming = false;
    this.state.cancelRequested = false;
    // Clear thinking indicator timeout
    if (this.state.thinkingIndicatorTimeout) {
      clearTimeout(this.state.thinkingIndicatorTimeout);
      this.state.thinkingIndicatorTimeout = null;
    }
    // Clear response timer
    this.clearFlavorTimerInterval();
    this.state.responseStartTime = null;
  }

  clearMaps(): void {
    this.state.toolCallElements.clear();
    this.state.writeEditStates.clear();
    this.state.pendingTools.clear();
  }

  resetForNewConversation(): void {
    this.clearMessages();
    this.resetStreamingState();
    this.clearMaps();
    this.state.queuedMessage = null;
    this.usage = null;
    this.currentTodos = null;
    this.autoScrollEnabled = true;
  }

  getPersistedMessages(): ChatMessage[] {
    // Return messages as-is - image data is single source of truth
    return this.state.messages;
  }
}

export { createInitialState };
