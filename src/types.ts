// Type definitions for Claudian plugin

export const VIEW_TYPE_CLAUDIAN = 'claudian-view';

// Available Claude models (base type can be any string for custom models)
export type ClaudeModel = string;

// Default Claude models
export const DEFAULT_CLAUDE_MODELS: { value: ClaudeModel; label: string; description: string }[] = [
  { value: 'claude-haiku-4-5', label: 'Haiku', description: 'Fast and efficient' },
  { value: 'claude-sonnet-4-5', label: 'Sonnet', description: 'Balanced performance' },
  { value: 'claude-opus-4-5', label: 'Opus', description: 'Most capable' },
];

// Thinking budget options
export type ThinkingBudget = 'off' | 'low' | 'medium' | 'high';

// Permission mode type
export type PermissionMode = 'yolo' | 'normal';

// Approved action structure (for memory system)
export interface ApprovedAction {
  toolName: string;           // e.g., 'Bash', 'Write', 'Edit'
  pattern: string;            // Command/path pattern that was approved
  approvedAt: number;         // Timestamp
  scope: 'session' | 'always'; // Session-only or permanent
}

export const THINKING_BUDGETS: { value: ThinkingBudget; label: string; tokens: number }[] = [
  { value: 'off', label: 'Off', tokens: 0 },
  { value: 'low', label: 'Low', tokens: 4000 },
  { value: 'medium', label: 'Med', tokens: 8000 },
  { value: 'high', label: 'High', tokens: 16000 },
];

// Default thinking budget per model
export const DEFAULT_THINKING_BUDGET: Record<string, ThinkingBudget> = {
  'claude-haiku-4-5': 'off',
  'claude-sonnet-4-5': 'low',
  'claude-opus-4-5': 'medium',
};

export interface ClaudianSettings {
  enableBlocklist: boolean;
  blockedCommands: string[];
  showToolUse: boolean;
  model: ClaudeModel;
  // Remember last selected models per category for smoother switching
  lastDefaultModel?: ClaudeModel;
  lastCustomModel?: ClaudeModel;
  thinkingBudget: ThinkingBudget;
  permissionMode: PermissionMode;
  approvedActions: ApprovedAction[];
  excludedTags: string[];  // Tags that exclude files from auto-loading context
  environmentVariables: string;  // Custom env vars in KEY=VALUE format (one per line)
  envSnippets: EnvSnippet[];  // Saved environment variable configurations
}

export interface EnvSnippet {
  id: string;
  name: string;
  description: string;
  envVars: string;
  createdAt: number;
  lastUsed?: number;
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
  lastDefaultModel: 'claude-haiku-4-5',
  lastCustomModel: '',
  thinkingBudget: 'off',
  permissionMode: 'yolo',
  approvedActions: [],
  excludedTags: [],
  environmentVariables: '',
  envSnippets: [],
};

// Conversation persistence types
export interface Conversation {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  sessionId: string | null;
  messages: ChatMessage[];
}

export interface ConversationMeta {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
  preview: string;
}

// Content block for tracking order of text and tool calls
export type ContentBlock =
  | { type: 'text'; content: string }
  | { type: 'tool_use'; toolId: string }
  | { type: 'thinking'; content: string; durationSeconds?: number };

// Message types for the chat UI
export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
  toolCalls?: ToolCallInfo[];
  // Ordered content blocks to preserve streaming order
  contentBlocks?: ContentBlock[];
  // File paths attached to this message via @ mention or auto-attach
  contextFiles?: string[];
}

// Enhanced tool call tracking with status and result
export interface ToolCallInfo {
  id: string;
  name: string;
  input: Record<string, unknown>;
  status: 'running' | 'completed' | 'error' | 'blocked';
  result?: string;
  isExpanded?: boolean;
}

// Stream chunk types from Claude Agent SDK
export type StreamChunk =
  | { type: 'text'; content: string }
  | { type: 'thinking'; content: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; id: string; content: string; isError?: boolean }
  | { type: 'error'; content: string }
  | { type: 'blocked'; content: string }
  | { type: 'done' };

// SDK Message Types (for type safety in message handling)
export interface SDKContentBlock {
  type: 'text' | 'tool_use' | 'tool_result' | 'thinking';
  text?: string;
  thinking?: string;  // Extended thinking content
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: string | unknown;
  is_error?: boolean;
}

export interface SDKMessageContent {
  content?: SDKContentBlock[];
}

export interface SDKStreamEvent {
  type: 'content_block_start' | 'content_block_delta';
  index?: number;  // Content block index for correlating deltas
  content_block?: SDKContentBlock;
  delta?: {
    type: 'text_delta' | 'thinking_delta';
    text?: string;
    thinking?: string;
  };
}

export interface SDKMessage {
  type: 'system' | 'assistant' | 'user' | 'stream_event' | 'result' | 'error' | 'tool_progress' | 'auth_status';
  subtype?: 'init' | 'compact_boundary' | 'status' | 'hook_response' | string;
  session_id?: string;
  message?: SDKMessageContent;
  tool_use_result?: string | unknown;
  parent_tool_use_id?: string | null;
  event?: SDKStreamEvent;
  error?: string;
  // tool_progress fields
  tool_use_id?: string;
  tool_name?: string;
  elapsed_time_seconds?: number;
  // auth_status fields
  isAuthenticating?: boolean;
  output?: string[];
}
