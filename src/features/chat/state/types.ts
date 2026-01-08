/**
 * Type definitions for chat state management.
 */

import type { EditorView } from '@codemirror/view';

import type {
  ChatMessage,
  ImageAttachment,
  SubagentInfo,
  ToolCallInfo,
  UsageInfo,
} from '../../../core/types';
import type {
  AsyncSubagentState,
  SubagentState,
  ThinkingBlockState,
  WriteEditState,
} from '../../../ui';
import type { TodoItem } from '../../../ui/renderers/TodoListRenderer';
import type { EditorSelectionContext } from '../../../utils/editor';

/** Queued message waiting to be sent after current streaming completes. */
export interface QueuedMessage {
  content: string;
  images?: ImageAttachment[];
  editorContext: EditorSelectionContext | null;
  promptPrefix?: string;
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

  // Tool and subagent tracking maps
  toolCallElements: Map<string, HTMLElement>;
  activeSubagents: Map<string, SubagentState>;
  asyncSubagentStates: Map<string, AsyncSubagentState>;
  writeEditStates: Map<string, WriteEditState>;

  // Context window usage
  usage: UsageInfo | null;
  // Flag to ignore usage updates (during session reset)
  ignoreUsageUpdates: boolean;
  // Count of subagents spawned during current streaming session (for filtering usage)
  subagentsSpawnedThisStream: number;

  // Current todo items for the persistent bottom panel
  currentTodos: TodoItem[] | null;
}

/** Callbacks for ChatState changes. */
export interface ChatStateCallbacks {
  onMessagesChanged?: () => void;
  onStreamingStateChanged?: (isStreaming: boolean) => void;
  onConversationChanged?: (id: string | null) => void;
  onUsageChanged?: (usage: UsageInfo | null) => void;
  onTodosChanged?: (todos: TodoItem[] | null) => void;
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
