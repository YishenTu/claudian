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
  AskUserQuestionState,
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
  hidden?: boolean;
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

/** Plan mode state for read-only planning workflow. */
export interface PlanModeState {
  /** Whether plan mode is currently active. */
  isActive: boolean;
  /** Path to the current plan file (e.g., .claude/plan/123456.md). */
  planFilePath: string | null;
  /** The plan content once written/read. */
  planContent: string | null;
  /** User's original query that started plan mode. */
  originalQuery: string | null;
  /** Whether plan mode was initiated by the agent (EnterPlanMode tool). */
  agentInitiated?: boolean;
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
  askUserQuestionStates: Map<string, AskUserQuestionState>;

  // Context window usage
  usage: UsageInfo | null;
  // Flag to ignore usage updates (during session reset)
  ignoreUsageUpdates: boolean;
  // Count of subagents spawned during current streaming session (for filtering usage)
  subagentsSpawnedThisStream: number;

  // Plan mode state
  planModeState: PlanModeState | null;
  // User-requested plan mode (UI/prompt prefix only)
  planModeRequested: boolean;
  // EnterPlanMode tool was called; switch permission mode after current reply
  planModeActivationPending: boolean;

  // Pending plan content awaiting user approval (persisted)
  pendingPlanContent: string | null;

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
  /** Enable plan mode (read-only exploration). */
  planMode?: boolean;
  /** Force cold-start query (bypass persistent query). */
  forceColdStart?: boolean;
  /** Session-specific external context paths (directories with full access). */
  externalContextPaths?: string[];
}

// Re-export types that are used across the chat feature
export type {
  AskUserQuestionState,
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
