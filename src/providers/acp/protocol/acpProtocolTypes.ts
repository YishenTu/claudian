// ACP (Agent Client Protocol) JSON-RPC types.
// Based on the Agent Client Protocol specification.
// Field names match the wire format (camelCase).

// ---------------------------------------------------------------------------
// JSON-RPC 2.0 base
// ---------------------------------------------------------------------------

export interface AcpJsonRpcRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params?: unknown;
}

export interface AcpJsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
}

export interface AcpJsonRpcResponse {
  jsonrpc: '2.0';
  id: number;
  result?: unknown;
  error?: AcpJsonRpcError;
}

export interface AcpJsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

// ---------------------------------------------------------------------------
// Initialize
// ---------------------------------------------------------------------------

export interface AcpClientCapabilities {
  chat?: boolean;
  tools?: boolean;
  agentLifecycle?: boolean;
  streaming?: boolean;
}

export interface AcpInitializeParams {
  clientInfo: { name: string; version: string };
  capabilities: AcpClientCapabilities;
}

export interface AcpServerInfo {
  name: string;
  version: string;
}

export interface AcpServerCapabilities {
  chat?: boolean;
  tools?: boolean;
  agentLifecycle?: boolean;
  streaming?: boolean;
}

export interface AcpInitializeResult {
  serverInfo: AcpServerInfo;
  capabilities: AcpServerCapabilities;
}

// ---------------------------------------------------------------------------
// Chat
// ---------------------------------------------------------------------------

export interface AcpTextContent {
  type: 'text';
  text: string;
}

export interface AcpToolUseContent {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface AcpToolResultContent {
  type: 'tool_result';
  toolUseId: string;
  content?: string;
  isError?: boolean;
}

export type AcpContentBlock = AcpTextContent | AcpToolUseContent | AcpToolResultContent;

export interface AcpMessage {
  role: 'user' | 'assistant' | 'system';
  content: string | AcpContentBlock[];
}

export interface AcpTool {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

export interface AcpChatParams {
  messages: AcpMessage[];
  stream?: boolean;
  tools?: AcpTool[];
  maxTokens?: number;
}

export interface AcpChatResult {
  messageId: string;
}

// ---------------------------------------------------------------------------
// Chat streaming notifications
// ---------------------------------------------------------------------------

export interface AcpTextDeltaParams {
  messageId: string;
  delta: string;
}

export interface AcpToolUseStartParams {
  messageId: string;
  toolUseId: string;
  name: string;
  input: Record<string, unknown>;
}

export interface AcpToolResultParams {
  messageId: string;
  toolUseId: string;
  content?: string;
  isError?: boolean;
}

export interface AcpMessageStopParams {
  messageId: string;
}

export interface AcpErrorParams {
  messageId: string;
  error: string;
}

// ---------------------------------------------------------------------------
// Tool approval (server request)
// ---------------------------------------------------------------------------

export interface AcpToolApprovalRequest {
  messageId: string;
  toolUseId: string;
  toolName: string;
  input: Record<string, unknown>;
  description?: string;
}

export type AcpToolApprovalDecision = 'allow' | 'deny' | 'allow-always';

export interface AcpToolApprovalResponse {
  decision: AcpToolApprovalDecision;
}

// ---------------------------------------------------------------------------
// User input (server request)
// ---------------------------------------------------------------------------

export interface AcpUserInputQuestion {
  id: string;
  header: string;
  question: string;
  options?: Array<{ label: string; description: string }>;
  isOther: boolean;
  isSecret: boolean;
}

export interface AcpUserInputRequest {
  messageId: string;
  questions: AcpUserInputQuestion[];
}

export interface AcpUserInputResponse {
  answers: Record<string, { answers: string[] }>;
}

// ---------------------------------------------------------------------------
// Shutdown
// ---------------------------------------------------------------------------

export interface AcpShutdownParams {
  reason?: string;
}

export interface AcpShutdownResult {
  acknowledged: boolean;
}
