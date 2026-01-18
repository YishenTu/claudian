/**
 * Type definitions for chat state management.
 */

import type { EditorView } from '@codemirror/view';

import type { TodoItem } from '../../../core/tools';
import type {
  ChatMessage,
  ImageAttachment,
  SubagentInfo,
  ToolCallInfo,
  UsageInfo,
} from '../../../core/types';
import type { EditorSelectionContext } from '../../../utils/editor';
import type {
  AsyncSubagentState,
  SubagentState,
  ThinkingBlockState,
  WriteEditState,
} from '../rendering';

/** Queued message waiting to be sent after current streaming completes. */
export interface QueuedMessage {
  content: string;
  images?: ImageAttachment[];
  editorContext: EditorSelectionContext | null;
  promptPrefix?: string;
}

/** Pending tool call waiting to be rendered (buffered until input is complete). */
export interface PendingToolCall {
  toolCall: ToolCallInfo;
  parentEl: HTMLElement;
}

/** Stored selection state from editor polling. */
export interface StoredSelection {
  notePath: string;
  selectedText: string;
  lineCount: number;
  startLine: number;
  from: number;
  to: number;
  editorView: EditorView;
}

/** Centralized chat state data. */
export interface ChatStateData {
  // Message state
  messages: ChatMessage[];

  // Streaming control
  isStreaming: boolean;
  cancelRequested: boolean;
  streamGeneration: number;
  /** Guards against concurrent operations during conversation creation. */
  isCreatingConversation: boolean;
  /** Guards against concurrent operations during conversation switching. */
  isSwitchingConversation: boolean;

  // Conversation identity
  currentConversationId: string | null;

  // Queued message
  queuedMessage: QueuedMessage | null;

  // Active streaming DOM state
  currentContentEl: HTMLElement | null;
  currentTextEl: HTMLElement | null;
  currentTextContent: string;
  currentThinkingState: ThinkingBlockState | null;
  thinkingEl: HTMLElement | null;
  queueIndicatorEl: HTMLElement | null;
  /** Debounce timeout for showing thinking indicator after inactivity. */
  thinkingIndicatorTimeout: ReturnType<typeof setTimeout> | null;

  // Tool and subagent tracking maps
  toolCallElements: Map<string, HTMLElement>;
  activeSubagents: Map<string, SubagentState>;
  asyncSubagentStates: Map<string, AsyncSubagentState>;
  writeEditStates: Map<string, WriteEditState>;
  /** Pending tool calls buffered until input is complete (for non-streaming-style render). */
  pendingTools: Map<string, PendingToolCall>;
  /** Pending Task tools buffered until sync/async is confirmed. */
  pendingTaskTools: Map<string, PendingToolCall>;

  // Context window usage
  usage: UsageInfo | null;
  // Flag to ignore usage updates (during session reset)
  ignoreUsageUpdates: boolean;
  // Count of subagents spawned during current streaming session (for filtering usage)
  subagentsSpawnedThisStream: number;

  // Current todo items for the persistent bottom panel
  currentTodos: TodoItem[] | null;

  // Attention state (approval pending, error, etc.)
  needsAttention: boolean;

  // Auto-scroll control during streaming
  autoScrollEnabled: boolean;

  // Response timer state
  responseStartTime: number | null;
  flavorTimerInterval: ReturnType<typeof setInterval> | null;
}

/** Callbacks for ChatState changes. */
export interface ChatStateCallbacks {
  onMessagesChanged?: () => void;
  onStreamingStateChanged?: (isStreaming: boolean) => void;
  onConversationChanged?: (id: string | null) => void;
  onUsageChanged?: (usage: UsageInfo | null) => void;
  onTodosChanged?: (todos: TodoItem[] | null) => void;
  onAttentionChanged?: (needsAttention: boolean) => void;
  onAutoScrollChanged?: (enabled: boolean) => void;
}

/** Options for query execution. */
export interface QueryOptions {
  allowedTools?: string[];
  model?: string;
  mcpMentions?: Set<string>;
  enabledMcpServers?: Set<string>;
  /** Force cold-start query (bypass persistent query). */
  forceColdStart?: boolean;
  /** Session-specific external context paths (directories with full access). */
  externalContextPaths?: string[];
}

// Re-export types that are used across the chat feature
export type {
  AsyncSubagentState,
  ChatMessage,
  EditorSelectionContext,
  ImageAttachment,
  SubagentInfo,
  SubagentState,
  ThinkingBlockState,
  TodoItem,
  ToolCallInfo,
  UsageInfo,
  WriteEditState,
};
