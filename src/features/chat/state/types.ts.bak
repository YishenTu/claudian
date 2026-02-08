import type { EditorView } from '@codemirror/view';

import type { TodoItem } from '../../../core/tools';
import type {
  ChatMessage,
  ImageAttachment,
  PermissionMode,
  SubagentInfo,
  ToolCallInfo,
  UsageInfo,
} from '../../../core/types';
import type { EditorSelectionContext } from '../../../utils/editor';
import type {
  ThinkingBlockState,
  WriteEditState,
} from '../rendering';

/** Queued message waiting to be sent after current streaming completes. */
export interface QueuedMessage {
  content: string;
  images?: ImageAttachment[];
  editorContext: EditorSelectionContext | null;
}

/** Pending tool call waiting to be rendered (buffered until input is complete). */
export interface PendingToolCall {
  toolCall: ToolCallInfo;
  parentEl: HTMLElement | null;
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

  // Tool tracking maps
  toolCallElements: Map<string, HTMLElement>;
  writeEditStates: Map<string, WriteEditState>;
  /** Pending tool calls buffered until input is complete (for non-streaming-style render). */
  pendingTools: Map<string, PendingToolCall>;

  // Context window usage
  usage: UsageInfo | null;
  // Flag to ignore usage updates (during session reset)
  ignoreUsageUpdates: boolean;

  // Current todo items for the persistent bottom panel
  currentTodos: TodoItem[] | null;

  // Attention state (approval pending, error, etc.)
  needsAttention: boolean;

  // Auto-scroll control during streaming
  autoScrollEnabled: boolean;

  // Response timer state
  responseStartTime: number | null;
  flavorTimerInterval: ReturnType<typeof setInterval> | null;

  // Pending plan content for approve-new-session (auto-sends in new session after stream ends)
  pendingNewSessionPlan: string | null;

  // Plan file path captured from Write tool calls to ~/.claude/plans/ during plan mode
  planFilePath: string | null;

  // Saved permission mode before entering plan mode (for Shift+Tab toggle restore)
  prePlanPermissionMode: PermissionMode | null;
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
  forceColdStart?: boolean;
  externalContextPaths?: string[];
}

// Re-export types that are used across the chat feature
export type {
  ChatMessage,
  EditorSelectionContext,
  ImageAttachment,
  PermissionMode,
  SubagentInfo,
  ThinkingBlockState,
  TodoItem,
  ToolCallInfo,
  UsageInfo,
  WriteEditState,
};
