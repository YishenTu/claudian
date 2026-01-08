/**
 * Centralized state management for chat feature.
 *
 * Manages all mutable state for the chat view, following the callback-based
 * pattern established by AsyncSubagentManager.
 */

import type { UsageInfo } from '../../../core/types';
import type {
  AsyncSubagentState,
  ChatMessage,
  ChatStateCallbacks,
  ChatStateData,
  QueuedMessage,
  SubagentState,
  ThinkingBlockState,
  TodoItem,
  WriteEditState,
} from './types';

/** Creates initial chat state. */
function createInitialState(): ChatStateData {
  return {
    messages: [],
    isStreaming: false,
    cancelRequested: false,
    currentConversationId: null,
    queuedMessage: null,
    currentContentEl: null,
    currentTextEl: null,
    currentTextContent: '',
    currentThinkingState: null,
    thinkingEl: null,
    queueIndicatorEl: null,
    toolCallElements: new Map(),
    activeSubagents: new Map(),
    asyncSubagentStates: new Map(),
    writeEditStates: new Map(),
    usage: null,
    ignoreUsageUpdates: false,
    subagentsSpawnedThisStream: 0,
    currentTodos: null,
  };
}

/**
 * ChatState manages all mutable state for the chat view.
 *
 * It provides typed accessors and mutators with optional callbacks
 * for state change notifications.
 */
export class ChatState {
  private state: ChatStateData;
  private callbacks: ChatStateCallbacks;

  constructor(callbacks: ChatStateCallbacks = {}) {
    this.state = createInitialState();
    this.callbacks = callbacks;
  }

  // ============================================
  // Messages
  // ============================================

  get messages(): ChatMessage[] {
    return this.state.messages;
  }

  set messages(value: ChatMessage[]) {
    this.state.messages = value;
    this.callbacks.onMessagesChanged?.();
  }

  addMessage(msg: ChatMessage): void {
    this.state.messages.push(msg);
    this.callbacks.onMessagesChanged?.();
  }

  clearMessages(): void {
    this.state.messages = [];
    this.callbacks.onMessagesChanged?.();
  }

  // ============================================
  // Streaming Control
  // ============================================

  get isStreaming(): boolean {
    return this.state.isStreaming;
  }

  set isStreaming(value: boolean) {
    this.state.isStreaming = value;
    this.callbacks.onStreamingStateChanged?.(value);
  }

  get cancelRequested(): boolean {
    return this.state.cancelRequested;
  }

  set cancelRequested(value: boolean) {
    this.state.cancelRequested = value;
  }

  // ============================================
  // Conversation
  // ============================================

  get currentConversationId(): string | null {
    return this.state.currentConversationId;
  }

  set currentConversationId(value: string | null) {
    this.state.currentConversationId = value;
    this.callbacks.onConversationChanged?.(value);
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

  // ============================================
  // Tool and Subagent Tracking Maps
  // ============================================

  get toolCallElements(): Map<string, HTMLElement> {
    return this.state.toolCallElements;
  }

  get activeSubagents(): Map<string, SubagentState> {
    return this.state.activeSubagents;
  }

  get asyncSubagentStates(): Map<string, AsyncSubagentState> {
    return this.state.asyncSubagentStates;
  }

  get writeEditStates(): Map<string, WriteEditState> {
    return this.state.writeEditStates;
  }

  // ============================================
  // Usage State
  // ============================================

  get usage(): UsageInfo | null {
    return this.state.usage;
  }

  set usage(value: UsageInfo | null) {
    this.state.usage = value;
    this.callbacks.onUsageChanged?.(value);
  }

  get ignoreUsageUpdates(): boolean {
    return this.state.ignoreUsageUpdates;
  }

  set ignoreUsageUpdates(value: boolean) {
    this.state.ignoreUsageUpdates = value;
  }

  get subagentsSpawnedThisStream(): number {
    return this.state.subagentsSpawnedThisStream;
  }

  set subagentsSpawnedThisStream(value: number) {
    this.state.subagentsSpawnedThisStream = value;
  }

  // ============================================
  // Current Todos (for persistent bottom panel)
  // ============================================

  get currentTodos(): TodoItem[] | null {
    return this.state.currentTodos;
  }

  set currentTodos(value: TodoItem[] | null) {
    // Normalize empty arrays to null for consistency
    const normalizedValue = (value && value.length > 0) ? value : null;
    this.state.currentTodos = normalizedValue;
    this.callbacks.onTodosChanged?.(normalizedValue);
  }

  // ============================================
  // Reset Methods
  // ============================================

  /** Resets streaming-related state. */
  resetStreamingState(): void {
    this.state.currentContentEl = null;
    this.state.currentTextEl = null;
    this.state.currentTextContent = '';
    this.state.currentThinkingState = null;
    this.state.isStreaming = false;
    this.state.cancelRequested = false;
  }

  /** Clears all maps for a new conversation. */
  clearMaps(): void {
    this.state.toolCallElements.clear();
    this.state.activeSubagents.clear();
    this.state.asyncSubagentStates.clear();
    this.state.writeEditStates.clear();
  }

  /** Resets all state for a new conversation. */
  resetForNewConversation(): void {
    this.clearMessages();
    this.resetStreamingState();
    this.clearMaps();
    this.state.queuedMessage = null;
    this.usage = null;
    this.currentTodos = null;
  }

  /** Gets persisted messages (strips image data). */
  getPersistedMessages(): ChatMessage[] {
    return this.state.messages.map(msg => ({
      ...msg,
      images: msg.images?.map(img => {
        const { data, ...rest } = img;
        return { ...rest };
      }),
    }));
  }
}

/** Creates an index.ts barrel export for the state module. */
export { createInitialState };
