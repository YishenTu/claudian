import type { EditorView } from '@codemirror/view';

import type { ProviderSelectionSnapshot, ProviderSessionReference } from '@/core/execution/ProviderExecutionRequest';
import type { BrowserSelectionContext } from '@/core/prompt/browserContext';
import type { CanvasSelectionContext } from '@/core/prompt/canvasContext';
import type { EditorSelectionContext } from '@/core/prompt/editorContext';

import type {
  ChatMessage,
  ImageAttachment,
  SubagentInfo,
  ToolCallInfo,
  UsageInfo,
} from '../../../core/types';
import type { ThinkingBlockState } from '../rendering/ThinkingBlockRenderer';
import type { WriteEditState } from '../rendering/WriteEditRenderer';

export interface ChatTurnRequest {
  selections?: readonly ProviderSelectionSnapshot[];
  /** Original composer text for recovery before provider acceptance. */
  draftContent?: string;
  sessionReferences?: readonly ProviderSessionReference[];
  text: string;
  images?: ImageAttachment[];
  linkedContentPath?: string;
  editorSelection?: EditorSelectionContext | null;
  browserSelection?: BrowserSelectionContext | null;
  canvasSelection?: CanvasSelectionContext | null;
}

/** Queued message waiting to be sent after current streaming completes. */
export interface QueuedMessage {
  /** Transient delivery observer; queues never persist callbacks. */
  onDelivery?: (accepted: boolean) => void;
  content: string;
  images?: ImageAttachment[];
  editorContext: EditorSelectionContext | null;
  browserContext?: BrowserSelectionContext | null;
  canvasContext: CanvasSelectionContext | null;
  /** Provider-neutral turn snapshot captured at enqueue time. */
  turnRequest?: ChatTurnRequest;
}

/** Pending tool call waiting to be rendered (buffered until input is complete). */
export interface PendingToolCall {
  toolCall: ToolCallInfo;
  parentEl: HTMLElement | null;
}

export type TabAttentionKind = 'review' | 'action-required';

export type TabReviewOutcome = 'completed' | 'error';

export type TabAttention =
  | {
      kind: 'review';
      outcome: TabReviewOutcome;
      since: number;
    }
  | {
      kind: 'action-required';
      since: number;
    }
  | null;

/** Stored selection state from editor polling. */
export interface StoredSelection {
  notePath: string;
  selectedText: string;
  lineCount: number;
  startLine?: number;
  from?: number;
  to?: number;
  editorView?: EditorView;
  domRanges?: Range[];
}

/** Centralized chat state data. */
export interface ChatStateData {
  // Message state
  messages: ChatMessage[];

  /** Guards against concurrent operations while the tab resets to a new chat. */
  isResettingToNewChat: boolean;
  /** Guards against concurrent operations during conversation switching. */
  isSwitchingConversation: boolean;
  /** Guards the destructive rewind transaction from overlapping tab actions. */
  isRewinding: boolean;
  /** Local tab state is ahead of persisted conversation metadata. */
  hasPendingConversationSave: boolean;

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
  thinkingIndicatorTimeout: number | null;

  // Tool tracking maps
  toolCallElements: Map<string, HTMLElement>;
  writeEditStates: Map<string, WriteEditState>;
  /** Pending tool calls buffered until input is complete (for non-streaming-style render). */
  pendingTools: Map<string, PendingToolCall>;

  // Context window usage
  usage: UsageInfo | null;
  // Flag to ignore usage updates (during session reset)
  ignoreUsageUpdates: boolean;

  // Runtime-only attention state
  attention: TabAttention;

  // Auto-scroll control during streaming
  autoScrollEnabled: boolean;

  // Response timer state
  responseStartTime: number | null;
  flavorTimerInterval: number | null;
}

/**
 * Runtime-only latest live activity. Streamed text keeps the current block's
 * immutable string, and tool activity references the live tool record, so
 * recording stays O(1) per chunk; consumers project it only when displayed.
 */
export type ChatActivity =
  | { kind: 'user'; text: string }
  | { kind: 'text'; text: string }
  | { kind: 'thinking' }
  | { kind: 'tool'; tool: ToolCallInfo }
  | { kind: 'error'; message: string };

/** Callbacks for ChatState changes. */
export interface ChatStateCallbacks {
  onStreamingStateChanged?: (isStreaming: boolean) => void;
  onRewindingStateChanged?: (isRewinding: boolean) => void;
  onConversationChanged?: (id: string | null) => void;
  onUsageChanged?: (usage: UsageInfo | null) => void;
  onAttentionChanged?: (attention: TabAttention) => void;
  onAutoScrollChanged?: (enabled: boolean) => void;
}

// Re-export types that are used across the chat feature
export type {
  ChatMessage,
  EditorSelectionContext,
  ImageAttachment,
  SubagentInfo,
  ThinkingBlockState,
  ToolCallInfo,
  UsageInfo,
  WriteEditState,
};
