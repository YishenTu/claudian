// Local protocol subset for Codex app-server stdio JSON-RPC.
// Field names match the wire format (camelCase).
// Probed against codex-cli 0.117.0 on 2026-03-28.

// ---------------------------------------------------------------------------
// JSON-RPC base
// ---------------------------------------------------------------------------

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params?: unknown;
}

export interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number;
  result?: unknown;
  error?: JsonRpcError;
}

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

// ---------------------------------------------------------------------------
// Initialize
// ---------------------------------------------------------------------------

export interface InitializeParams {
  clientInfo: { name: string; version: string };
  capabilities: { experimentalApi?: boolean };
}

export interface InitializeResult {
  userAgent: string;
  codexHome: string;
  platformFamily: string;
  platformOs: string;
}

// ---------------------------------------------------------------------------
// Thread
// ---------------------------------------------------------------------------

export interface Thread {
  id: string;
  preview: string;
  ephemeral: boolean;
  path: string;
  cwd: string;
  cliVersion: string;
  status: ThreadStatus;
  turns: Turn[];
  createdAt: number;
  updatedAt: number;
  name: string | null;
  modelProvider: string;
  source: string;
  agentNickname: string | null;
  agentRole: string | null;
  gitInfo: GitInfo | null;
}

export interface ThreadStatus {
  type: 'idle' | 'active' | 'systemError';
  activeFlags?: string[];
}

export interface GitInfo {
  sha: string;
  branch: string;
  originUrl: string;
}

export interface Turn {
  id: string;
  items: ThreadItem[];
  status: 'inProgress' | 'completed' | 'failed' | 'interrupted';
  error: TurnError | null;
}

export interface TurnError {
  message: string;
  codexErrorInfo: string | Record<string, unknown>;
  additionalDetails: string | null;
}

// ---------------------------------------------------------------------------
// Thread items
// ---------------------------------------------------------------------------

export type ThreadItem =
  | UserMessageItem
  | AgentMessageItem
  | ReasoningItem
  | CommandExecutionItem
  | FileChangeItem
  | ImageViewItem
  | WebSearchItem
  | CollabAgentToolCallItem
  | McpToolCallItem;

export interface UserMessageItem {
  type: 'userMessage';
  id: string;
  content: UserInput[];
}

export interface AgentMessageItem {
  type: 'agentMessage';
  id: string;
  text: string;
  phase: string;
  memoryCitation: unknown | null;
}

export interface ReasoningItem {
  type: 'reasoning';
  id: string;
  summary: unknown[];
  content: unknown[];
}

export interface CommandExecutionItem {
  type: 'commandExecution';
  id: string;
  command: string;
  cwd: string;
  processId: string;
  source: string;
  status: string;
  commandActions: CommandAction[];
  aggregatedOutput: string | null;
  exitCode: number | null;
  durationMs: number | null;
}

export interface CommandAction {
  type: string;
  command: string;
}

export interface FileChangeItem {
  type: 'fileChange';
  id: string;
  changes: FileChangeEntry[];
}

export interface FileChangeEntry {
  path: string;
  type: string;
}

export interface ImageViewItem {
  type: 'imageView';
  id: string;
  path: string;
}

export interface WebSearchItem {
  type: 'webSearch';
  id: string;
  query?: string;
  action?: { type?: string; query?: string };
  status?: string;
}

export interface CollabAgentToolCallItem {
  type: 'collabAgentToolCall';
  id: string;
  tool: string;
  status?: string;
  arguments?: Record<string, unknown>;
  result?: unknown;
}

export interface McpToolCallItem {
  type: 'mcpToolCall';
  id: string;
  server: string;
  tool: string;
  status?: string;
  arguments?: Record<string, unknown>;
  result?: { content?: Array<{ type?: string; text?: string }> } | null;
  error?: string | null;
  durationMs?: number | null;
}

// ---------------------------------------------------------------------------
// User input
// ---------------------------------------------------------------------------

export interface TextInput {
  type: 'text';
  text: string;
  text_elements?: unknown[];
}

export interface LocalImageInput {
  type: 'localImage';
  path: string;
}

export type UserInput = TextInput | LocalImageInput;

// ---------------------------------------------------------------------------
// thread/start
// ---------------------------------------------------------------------------

export interface ThreadStartParams {
  model: string;
  cwd: string;
  approvalPolicy: string;
  sandbox: string;
  baseInstructions?: string;
  experimentalRawEvents?: boolean;
  persistExtendedHistory?: boolean;
  sandboxPolicy?: SandboxPolicy;
}

export interface ThreadStartResult {
  thread: Thread;
  model: string;
  modelProvider: string;
  serviceTier: string | null;
  cwd: string;
  approvalPolicy: string;
  approvalsReviewer: string;
  sandbox: SandboxPolicy;
  reasoningEffort: string;
}

export interface SandboxPolicy {
  type: string;
  writableRoots: string[];
  readOnlyAccess: { type: string };
  networkAccess: boolean;
  excludeTmpdirEnvVar: boolean;
  excludeSlashTmp: boolean;
}

// ---------------------------------------------------------------------------
// thread/resume
// ---------------------------------------------------------------------------

export interface ThreadResumeParams {
  threadId: string;
  baseInstructions?: string;
  persistExtendedHistory?: boolean;
}

export type ThreadResumeResult = ThreadStartResult;

// ---------------------------------------------------------------------------
// turn/start
// ---------------------------------------------------------------------------

export interface TurnStartParams {
  threadId: string;
  input: UserInput[];
  model?: string;
  effort?: string;
  summary?: 'auto' | 'concise' | 'detailed' | 'none';
  sandboxPolicy?: SandboxPolicy;
}

export interface TurnStartResult {
  turn: Turn;
}

// ---------------------------------------------------------------------------
// turn/interrupt
// ---------------------------------------------------------------------------

export interface TurnInterruptParams {
  threadId: string;
  turnId: string;
}

// ---------------------------------------------------------------------------
// Server notifications
// ---------------------------------------------------------------------------

export interface ThreadStartedNotification {
  thread: Thread;
}

export interface ThreadStatusChangedNotification {
  threadId: string;
  status: ThreadStatus;
}

export interface TurnStartedNotification {
  threadId: string;
  turn: Turn;
}

export interface TurnCompletedNotification {
  threadId: string;
  turn: Turn;
}

export interface ItemStartedNotification {
  item: ThreadItem;
  threadId: string;
  turnId: string;
}

export interface ItemCompletedNotification {
  item: ThreadItem;
  threadId: string;
  turnId: string;
}

export interface AgentMessageDeltaNotification {
  threadId: string;
  turnId: string;
  itemId: string;
  delta: string;
}

export interface TokenUsage {
  totalTokens: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
}

export interface TokenUsageUpdatedNotification {
  threadId: string;
  turnId: string;
  tokenUsage: {
    total: TokenUsage;
    last: TokenUsage;
    modelContextWindow: number;
  };
}

export interface PlanStep {
  step: string;
  status: string;
}

export interface TurnPlanUpdatedNotification {
  threadId: string;
  turnId: string;
  explanation: string | null;
  plan: PlanStep[];
}

export interface ErrorNotification {
  error: TurnError;
  willRetry: boolean;
  threadId: string;
  turnId: string;
}

export interface ReasoningSummaryPartAddedNotification {
  threadId: string;
  turnId: string;
  itemId: string;
  summaryIndex: number;
}

export interface ReasoningSummaryTextDeltaNotification {
  threadId: string;
  turnId: string;
  itemId: string;
  summaryIndex: number;
  delta: string;
}

// ---------------------------------------------------------------------------
// Server requests (require client response)
// ---------------------------------------------------------------------------

export interface CommandApprovalRequest {
  threadId: string;
  turnId: string;
  itemId: string;
  command: string;
  cwd: string;
}

export interface FileChangeApprovalRequest {
  threadId: string;
  turnId: string;
  itemId: string;
  changes: FileChangeEntry[];
}

export interface PermissionsApprovalRequest {
  threadId: string;
  turnId: string;
  itemId: string;
}

export interface ApprovalResponse {
  decision: 'accept' | 'deny' | 'alwaysAccept';
}

export interface UserInputRequest {
  threadId: string;
  turnId: string;
  questions: Array<{
    id: string;
    text: string;
  }>;
}

export interface UserInputResponse {
  answers: Record<string, { answers: string[] }>;
}
