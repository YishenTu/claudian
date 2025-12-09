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
  lastClaudeModel?: ClaudeModel;
  lastCustomModel?: ClaudeModel;
  thinkingBudget: ThinkingBudget;
  permissionMode: PermissionMode;
  approvedActions: ApprovedAction[];
  excludedTags: string[];  // Tags that exclude files from auto-loading context
  mediaFolder: string;  // Folder for attachments/media (e.g., "- attachments"), empty for root
  environmentVariables: string;  // Custom env vars in KEY=VALUE format (one per line)
  envSnippets: EnvSnippet[];  // Saved environment variable configurations
  systemPrompt: string;  // Custom system prompt appended to default
}

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
  thinkingBudget: 'off',
  permissionMode: 'yolo',
  approvedActions: [],
  excludedTags: [],
  mediaFolder: '',
  environmentVariables: '',
  envSnippets: [],
  systemPrompt: '',
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
  | { type: 'thinking'; content: string; durationSeconds?: number }
  | { type: 'subagent'; subagentId: string; mode?: SubagentMode };

// Subagent execution mode
// - sync: Traditional nested subagent with tool tracking (parentToolUseId routing)
// - async: Background subagent with no nested tool tracking (run_in_background=true)
export type SubagentMode = 'sync' | 'async';

// Async subagent lifecycle states
export type AsyncSubagentStatus =
  | 'pending'         // Task initiated, waiting for agent_id from tool_result
  | 'running'         // agent_id received, subagent is active in background
  | 'awaiting_result' // SubagentStop hook fired, waiting for AgentOutputTool
  | 'completed'       // AgentOutputTool received with success
  | 'error'           // AgentOutputTool received with error
  | 'orphaned';       // Conversation ended before AgentOutputTool (auto-errored)

// Supported image media types
export type ImageMediaType = 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';

// Image attachment for sending to Claude
export interface ImageAttachment {
  id: string;
  name: string;           // Original filename or generated name
  mediaType: ImageMediaType;
  data?: string;          // Base64-encoded image data (not persisted)
  cachePath?: string;     // Cached file path relative to vault (e.g., .claudian-cache/images/abc.jpg)
  filePath?: string;      // Original file path (relative to vault or absolute)
  width?: number;         // Image dimensions (if known)
  height?: number;
  size: number;           // File size in bytes
  source: 'file' | 'paste' | 'drop';  // How the image was added
}

// Message types for the chat UI
export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
  toolCalls?: ToolCallInfo[];
  // Subagent (Task tool) tracking
  subagents?: SubagentInfo[];
  // Ordered content blocks to preserve streaming order
  contentBlocks?: ContentBlock[];
  // File paths attached to this message via @ mention or auto-attach
  contextFiles?: string[];
  // Images attached to this message
  images?: ImageAttachment[];
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

// Subagent (Task tool) tracking - supports both sync and async modes
export interface SubagentInfo {
  id: string;                    // The Task tool_use_id
  description: string;           // Task description (from input.description)
  mode?: SubagentMode;           // 'sync' (default) or 'async' (run_in_background=true)
  isExpanded: boolean;
  result?: string;               // Final result when completed

  // Sync mode fields (mode === 'sync' or undefined)
  status: 'running' | 'completed' | 'error';  // Sync status (3-state)
  toolCalls: ToolCallInfo[];     // Nested tool calls from this subagent (sync only)

  // Async mode fields (mode === 'async')
  asyncStatus?: AsyncSubagentStatus;  // Async status (6-state lifecycle)
  agentId?: string;              // Parsed from Task tool_result (snake_case from SDK)
  outputToolId?: string;         // AgentOutputTool tool_use_id (for linking result)
  startedAt?: number;            // Timestamp when agent_id received
  completedAt?: number;          // Timestamp when AgentOutputTool received
}

// Stream chunk types from Claude Agent SDK
export type StreamChunk =
  | { type: 'text'; content: string; parentToolUseId?: string | null }
  | { type: 'thinking'; content: string; parentToolUseId?: string | null }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown>; parentToolUseId?: string | null }
  | { type: 'tool_result'; id: string; content: string; isError?: boolean; parentToolUseId?: string | null }
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
