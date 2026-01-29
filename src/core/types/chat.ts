/**
 * Chat and conversation type definitions.
 */

import type { SDKToolUseResult } from './diff';
import type { SubagentInfo, SubagentMode, ToolCallInfo } from './tools';

/** View type identifier for Obsidian. */
export const VIEW_TYPE_CLAUDIAN = 'claudian-view';

/** Supported image media types for attachments. */
export type ImageMediaType = 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';

/** Image attachment metadata. */
export interface ImageAttachment {
  id: string;
  name: string;
  mediaType: ImageMediaType;
  /** Base64 encoded image data - single source of truth. */
  data: string;
  width?: number;
  height?: number;
  size: number;
  source: 'file' | 'paste' | 'drop';
}

/** Content block for preserving streaming order in messages. */
export type ContentBlock =
  | { type: 'text'; content: string }
  | { type: 'tool_use'; toolId: string }
  | { type: 'thinking'; content: string; durationSeconds?: number }
  | { type: 'subagent'; subagentId: string; mode?: SubagentMode }
  | { type: 'compact_boundary' };

/** Chat message with content, tool calls, and attachments. */
export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  /** Display-only content (e.g., "/tests" when content is the expanded prompt). */
  displayContent?: string;
  timestamp: number;
  toolCalls?: ToolCallInfo[];
  subagents?: SubagentInfo[];
  contentBlocks?: ContentBlock[];
  currentNote?: string;
  images?: ImageAttachment[];
  /** True if this message represents a user interrupt (from SDK storage). */
  isInterrupt?: boolean;
  /** True if this message is rebuilt context sent to SDK on session reset (should be hidden). */
  isRebuiltContext?: boolean;
  /** Duration in seconds from user send to response completion. */
  durationSeconds?: number;
  /** Flavor word used for duration display (e.g., "Baked", "Cooked"). */
  durationFlavorWord?: string;
}

/** Persisted conversation with messages and session state. */
export interface Conversation {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  /** Timestamp when the last agent response completed. */
  lastResponseAt?: number;
  sessionId: string | null;
  /**
   * Current SDK session ID for native sessions.
   * May differ from sessionId when SDK creates a new session (session expired, API key changed).
   * Used for loading messages from SDK storage. Falls back to sessionId if not set.
   */
  sdkSessionId?: string;
  /**
   * Previous SDK session IDs from session rebuilds.
   * When resume fails and SDK creates a new session, the old sdkSessionId is moved here.
   * Used to load and merge messages from all session files for display.
   */
  previousSdkSessionIds?: string[];
  messages: ChatMessage[];
  currentNote?: string;
  /** Session-specific external context paths (directories with full access). Resets on new session. */
  externalContextPaths?: string[];
  /** Context window usage information. */
  usage?: UsageInfo;
  /** Status of AI title generation. */
  titleGenerationStatus?: 'pending' | 'success' | 'failed';
  /** UI-enabled MCP servers for this session (context-saving servers activated via selector). */
  enabledMcpServers?: string[];
  /** True if this conversation uses SDK-native storage (messages in ~/.claude/projects/). */
  isNative?: boolean;
  /** Timestamp of the last legacy JSONL message (used to merge SDK history). */
  legacyCutoffAt?: number;
  /** Internal flag to avoid reloading SDK history repeatedly. */
  sdkMessagesLoaded?: boolean;
  /**
   * Cached subagent data for Task tool operations.
   * Loaded from metadata for native sessions to restore tool count and status on reload.
   */
  subagentData?: Record<string, SubagentInfo>;
}

/** Lightweight conversation metadata for the history dropdown. */
export interface ConversationMeta {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  /** Timestamp when the last agent response completed. */
  lastResponseAt?: number;
  messageCount: number;
  preview: string;
  /** Status of AI title generation. */
  titleGenerationStatus?: 'pending' | 'success' | 'failed';
  /** True if this conversation uses SDK-native storage. */
  isNative?: boolean;
}

/**
 * Session metadata overlay for SDK-native storage.
 * Stored in vault/.claude/sessions/{id}.meta.json
 * SDK handles message storage; this stores UI-only state.
 */
export interface SessionMetadata {
  id: string;
  title: string;
  titleGenerationStatus?: 'pending' | 'success' | 'failed';
  createdAt: number;
  updatedAt: number;
  lastResponseAt?: number;
  /** Session ID used for SDK resume (may be cleared when invalidated). */
  sessionId?: string | null;
  /**
   * Current SDK session ID. May differ from id when SDK creates a new session.
   * Used to locate the correct SDK session file for message loading.
   */
  sdkSessionId?: string;
  /**
   * Previous SDK session IDs from session rebuilds.
   * When resume fails and SDK creates a new session, the old sdkSessionId is moved here.
   * Used to load and merge messages from all session files for display.
   */
  previousSdkSessionIds?: string[];
  currentNote?: string;
  externalContextPaths?: string[];
  enabledMcpServers?: string[];
  usage?: UsageInfo;
  /** Timestamp of the last legacy JSONL message (used to merge SDK history). */
  legacyCutoffAt?: number;
  /**
   * Subagent data for Task tool operations.
   * Maps toolUseId to subagent info (tool count, status, result).
   * Stored here because SDK session files don't preserve this Claudian-specific data.
   */
  subagentData?: Record<string, SubagentInfo>;
}

/** Normalized stream chunk from the Claude Agent SDK. */
export type StreamChunk =
  | { type: 'text'; content: string; parentToolUseId?: string | null }
  | { type: 'thinking'; content: string; parentToolUseId?: string | null }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown>; parentToolUseId?: string | null }
  | { type: 'tool_result'; id: string; content: string; isError?: boolean; parentToolUseId?: string | null; toolUseResult?: SDKToolUseResult }
  | { type: 'error'; content: string }
  | { type: 'blocked'; content: string }
  | { type: 'done' }
  | { type: 'usage'; usage: UsageInfo; sessionId?: string | null }
  | { type: 'compact_boundary' };

/** Context window usage information. */
export interface UsageInfo {
  model?: string;
  inputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  contextWindow: number;
  contextTokens: number;
  percentage: number;
}
