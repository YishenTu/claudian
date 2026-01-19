/**
 * iFlow SDK Type Definitions
 *
 * Types for the iFlow CLI SDK integration.
 * Based on iFlow TypeScript SDK documentation.
 */

// ============================================
// Message Types from iFlow SDK
// ============================================

/** Agent information parsed from iFlow agent IDs */
export interface AgentInfo {
  agentId: string;
  agentIndex?: number;
  taskId?: string;
  timestamp?: number;
}

/** Text chunk in assistant message */
export interface TextChunk {
  text: string;
}

/** AI assistant text response */
export interface AssistantMessage {
  type: 'assistant';
  chunk: TextChunk;
  agentId?: string;
  agentInfo?: AgentInfo;
}

/** Tool execution status */
export type ToolCallStatus = 'pending' | 'running' | 'completed' | 'failed';

/** Tool execution request and status */
export interface ToolCallMessage {
  type: 'tool_call';
  label: string;
  status: ToolCallStatus;
  toolName: string;
  toolId?: string;
  input?: Record<string, unknown>;
  result?: string;
  agentId?: string;
  agentInfo?: AgentInfo;
}

/** Plan entry in task planning */
export interface PlanEntry {
  content: string;
  priority?: number;
  status?: 'pending' | 'in_progress' | 'completed';
}

/** Structured task plan */
export interface PlanMessage {
  type: 'plan';
  entries: PlanEntry[];
}

/** Task completion signal */
export interface TaskFinishMessage {
  type: 'task_finish';
  stopReason?: string;
}

/** User message */
export interface UserMessage {
  type: 'user';
  chunks: TextChunk[];
}

/** Error message */
export interface ErrorMessage {
  type: 'error';
  code?: string;
  message: string;
}

/** Thinking/reasoning message (if supported) */
export interface ThinkingMessage {
  type: 'thinking';
  content: string;
}

/** Union type for all iFlow messages */
export type IFlowMessage =
  | AssistantMessage
  | ToolCallMessage
  | PlanMessage
  | TaskFinishMessage
  | UserMessage
  | ErrorMessage
  | ThinkingMessage;

// ============================================
// Client Configuration
// ============================================

/** iFlow client configuration options */
export interface IFlowOptions {
  /** WebSocket host (default: localhost) */
  host?: string;
  /** WebSocket port (default: auto-detect) */
  port?: number;
  /** Connection timeout in milliseconds */
  timeout?: number;
  /** Whether to auto-start iFlow process (default: true) */
  autoStart?: boolean;
  /** Working directory for iFlow */
  cwd?: string;
  /** Environment variables */
  env?: Record<string, string>;
  /** Custom iFlow CLI path */
  cliPath?: string;
  /** Enable debug logging */
  debug?: boolean;
}

/** Query options for sending messages */
export interface IFlowQueryOptions {
  /** Session ID for conversation continuity */
  sessionId?: string;
  /** Model to use */
  model?: string;
  /** System prompt */
  systemPrompt?: string;
  /** Maximum thinking tokens */
  maxThinkingTokens?: number;
  /** Allowed tools */
  tools?: string[];
  /** MCP server configurations */
  mcpServers?: Record<string, unknown>;
  /** Additional context paths */
  additionalDirectories?: string[];
}

// ============================================
// Client Interface
// ============================================

/** Interface for iFlow client operations */
export interface IIFlowClient {
  /** Connect to iFlow */
  connect(): Promise<void>;
  /** Disconnect from iFlow */
  disconnect(): Promise<void>;
  /** Check if connected */
  isConnected(): boolean;
  /** Send a message and receive streaming responses */
  sendMessage(content: string, options?: IFlowQueryOptions): AsyncIterableIterator<IFlowMessage>;
  /** Send a message with images */
  sendMessageWithImages(
    content: string,
    images: Array<{ data: string; mediaType: string }>,
    options?: IFlowQueryOptions
  ): AsyncIterableIterator<IFlowMessage>;
  /** Interrupt current operation */
  interrupt(): Promise<void>;
  /** Get current session ID */
  getSessionId(): string | null;
}

// ============================================
// Callback Types
// ============================================

/** Callback for tool approval */
export type ToolApprovalCallback = (
  toolName: string,
  input: Record<string, unknown>
) => Promise<'allow' | 'deny'>;

/** Callback for message events */
export type MessageCallback = (message: IFlowMessage) => void;

/** Callback for error events */
export type ErrorCallback = (error: Error) => void;
