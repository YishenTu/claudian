/**
 * Claudian - Type definitions
 *
 * Shared types for settings, conversations, messages, and SDK integration.
 */

export const VIEW_TYPE_CLAUDIAN = 'claudian-view';

/** Model identifier (string to support custom models via environment variables). */
export type ClaudeModel = string;

/** Default Claude model options. */
export const DEFAULT_CLAUDE_MODELS: { value: ClaudeModel; label: string; description: string }[] = [
  { value: 'claude-haiku-4-5', label: 'Haiku', description: 'Fast and efficient' },
  { value: 'claude-sonnet-4-5', label: 'Sonnet', description: 'Balanced performance' },
  { value: 'claude-opus-4-5', label: 'Opus', description: 'Most capable' },
];

/** Extended thinking token budget levels. */
export type ThinkingBudget = 'off' | 'low' | 'medium' | 'high';

/** Permission mode for tool execution. */
export type PermissionMode = 'yolo' | 'normal';

/** Permanently approved tool action pattern. */
export interface ApprovedAction {
  toolName: string;
  pattern: string;
  approvedAt: number;
  scope: 'session' | 'always';
}

/** Thinking budget configuration with token counts. */
export const THINKING_BUDGETS: { value: ThinkingBudget; label: string; tokens: number }[] = [
  { value: 'off', label: 'Off', tokens: 0 },
  { value: 'low', label: 'Low', tokens: 4000 },
  { value: 'medium', label: 'Med', tokens: 8000 },
  { value: 'high', label: 'High', tokens: 16000 },
];

/** Default thinking budget per model tier. */
export const DEFAULT_THINKING_BUDGET: Record<string, ThinkingBudget> = {
  'claude-haiku-4-5': 'off',
  'claude-sonnet-4-5': 'low',
  'claude-opus-4-5': 'medium',
};

/** Plugin settings persisted to disk. */
export interface ClaudianSettings {
  enableBlocklist: boolean;
  blockedCommands: string[];
  showToolUse: boolean;
  model: ClaudeModel;
  lastClaudeModel?: ClaudeModel;
  lastCustomModel?: ClaudeModel;
  lastEnvHash?: string;
  thinkingBudget: ThinkingBudget;
  permissionMode: PermissionMode;
  approvedActions: ApprovedAction[];
  excludedTags: string[];
  mediaFolder: string;
  environmentVariables: string;
  envSnippets: EnvSnippet[];
  systemPrompt: string;
}

/** Saved environment variable configuration. */
export interface EnvSnippet {
  id: string;
  name: string;
  description: string;
  envVars: string;
}

export const DEFAULT_SETTINGS: ClaudianSettings = {
  enableBlocklist: true,
  blockedCommands: [
    'rm -rf',
    'chmod 777',
    'chmod -R 777',
  ],
  showToolUse: true,
  model: 'claude-haiku-4-5',
  lastClaudeModel: 'claude-haiku-4-5',
  lastCustomModel: '',
  lastEnvHash: '',
  thinkingBudget: 'off',
  permissionMode: 'yolo',
  approvedActions: [],
  excludedTags: [],
  mediaFolder: '',
  environmentVariables: '',
  envSnippets: [],
  systemPrompt: '',
};

/** Persisted conversation with messages and session state. */
export interface Conversation {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  sessionId: string | null;
  messages: ChatMessage[];
  attachedFiles?: string[];
}

/** Lightweight conversation metadata for the history dropdown. */
export interface ConversationMeta {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
  preview: string;
}

/** Content block for preserving streaming order in messages. */
export type ContentBlock =
  | { type: 'text'; content: string }
  | { type: 'tool_use'; toolId: string }
  | { type: 'thinking'; content: string; durationSeconds?: number }
  | { type: 'subagent'; subagentId: string; mode?: SubagentMode };

/** Subagent execution mode: sync (nested tools) or async (background). */
export type SubagentMode = 'sync' | 'async';

/** Async subagent lifecycle states. */
export type AsyncSubagentStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'error'
  | 'orphaned';

/** Supported image media types for attachments. */
export type ImageMediaType = 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';

/** Image attachment metadata. */
export interface ImageAttachment {
  id: string;
  name: string;
  mediaType: ImageMediaType;
  data?: string;
  cachePath?: string;
  filePath?: string;
  width?: number;
  height?: number;
  size: number;
  source: 'file' | 'paste' | 'drop';
}

/** Chat message with content, tool calls, and attachments. */
export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
  toolCalls?: ToolCallInfo[];
  subagents?: SubagentInfo[];
  contentBlocks?: ContentBlock[];
  contextFiles?: string[];
  images?: ImageAttachment[];
}

/** Tool call tracking with status and result. */
export interface ToolCallInfo {
  id: string;
  name: string;
  input: Record<string, unknown>;
  status: 'running' | 'completed' | 'error' | 'blocked';
  result?: string;
  isExpanded?: boolean;
  diffData?: ToolDiffData;
}

/** Diff data for Write/Edit tool operations. */
export interface ToolDiffData {
  originalContent?: string;
  newContent?: string;
  filePath: string;
  skippedReason?: 'too_large' | 'unavailable';
}

/** Subagent (Task tool) tracking for sync and async modes. */
export interface SubagentInfo {
  id: string;
  description: string;
  mode?: SubagentMode;
  isExpanded: boolean;
  result?: string;
  status: 'running' | 'completed' | 'error';
  toolCalls: ToolCallInfo[];
  asyncStatus?: AsyncSubagentStatus;
  agentId?: string;
  outputToolId?: string;
  startedAt?: number;
  completedAt?: number;
}

/** Normalized stream chunk from the Claude Agent SDK. */
export type StreamChunk =
  | { type: 'text'; content: string; parentToolUseId?: string | null }
  | { type: 'thinking'; content: string; parentToolUseId?: string | null }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown>; parentToolUseId?: string | null }
  | { type: 'tool_result'; id: string; content: string; isError?: boolean; parentToolUseId?: string | null }
  | { type: 'error'; content: string }
  | { type: 'blocked'; content: string }
  | { type: 'done' };

/** SDK content block structure. */
export interface SDKContentBlock {
  type: 'text' | 'tool_use' | 'tool_result' | 'thinking';
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: string | unknown;
  is_error?: boolean;
}

/** SDK message content wrapper. */
export interface SDKMessageContent {
  content?: SDKContentBlock[];
}

/** SDK stream event structure. */
export interface SDKStreamEvent {
  type: 'content_block_start' | 'content_block_delta';
  index?: number;
  content_block?: SDKContentBlock;
  delta?: {
    type: 'text_delta' | 'thinking_delta';
    text?: string;
    thinking?: string;
  };
}

/** SDK message structure from the Claude Agent SDK. */
export interface SDKMessage {
  type: 'system' | 'assistant' | 'user' | 'stream_event' | 'result' | 'error' | 'tool_progress' | 'auth_status';
  subtype?: 'init' | 'compact_boundary' | 'status' | 'hook_response' | string;
  session_id?: string;
  message?: SDKMessageContent;
  tool_use_result?: string | unknown;
  parent_tool_use_id?: string | null;
  event?: SDKStreamEvent;
  error?: string;
  tool_use_id?: string;
  tool_name?: string;
  elapsed_time_seconds?: number;
  isAuthenticating?: boolean;
  output?: string[];
}
