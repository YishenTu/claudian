// Local protocol subset for Codex app-server stdio JSON-RPC.
// Field names match the wire format (camelCase).
// Validated against codex-cli 0.171.0 generate-json-schema --experimental.
// Includes only consumed fields, plus legacy shapes accepted on older threads.

// ---------------------------------------------------------------------------
// JSON-RPC base
// ---------------------------------------------------------------------------

export interface JSONRPCError {
  code: number;
  message: string;
  data?: unknown;
}

export interface InitializeResult {
  userAgent: string;
  codexHome?: string;
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
  path: string | null;
  cwd: string;
  cliVersion: string;
  status: ThreadStatus;
  turns: Turn[];
  createdAt: number;
  updatedAt: number;
  name: string | null;
  modelProvider: string;
  model?: string | null;
  reasoningEffort?: string | null;
  source: string | { custom: string } | { subAgent: string | { other: string } | { thread_spawn: { parent_thread_id: string } } };
  parentThreadId?: string | null;
  agentNickname: string | null;
  agentRole: string | null;
  gitInfo: GitInfo | null;
}

export interface ThreadStatus {
  type: 'idle' | 'active' | 'systemError' | 'notLoaded';
  activeFlags?: string[];
}

export interface GitInfo {
  sha: string | null;
  branch: string | null;
  originUrl: string | null;
}

export interface Turn {
  id: string;
  durationMs?: number | null;
  items: ThreadItem[];
  status: 'inProgress' | 'completed' | 'failed' | 'interrupted';
  error: TurnError | null;
}

export interface TurnError {
  message: string;
  codexErrorInfo: string | Record<string, unknown> | null;
  additionalDetails: string | null;
}

// ---------------------------------------------------------------------------
// Thread items
// ---------------------------------------------------------------------------

export type ThreadItem =
  | UserMessageItem
  | AgentMessageItem
  | PlanItem
  | ReasoningItem
  | CommandExecutionItem
  | FileChangeItem
  | ImageViewItem
  | WebSearchItem
  | SubAgentActivityItem
  | CollabAgentToolCallItem
  | MCPToolCallItem
  | DynamicToolCallItem
  | ContextCompactionItem
  | HookPromptItem
  | { type: 'functionCallOutput' | 'sleep' | 'imageGeneration' | 'enteredReviewMode' | 'exitedReviewMode'; id: string };

export interface UserMessageItem {
  type: 'userMessage';
  id: string;
  content: UserInput[];
}

export interface AgentMessageItem {
  delivery?: 'async' | null;
  questions?: Array<{ title: string; options: string[] | null }> | null;
  type: 'agentMessage';
  id: string;
  text: string;
  phase: string | null;
  memoryCitation: CodexMemoryCitation | null;
}

export interface CodexMemoryCitation {
  entries: CodexMemoryCitationEntry[];
  threadIds: string[];
}

export interface CodexMemoryCitationEntry {
  path: string;
  lineStart: number;
  lineEnd: number;
  note: string;
}

export interface PlanItem {
  type: 'plan';
  id: string;
  text: string;
}

export interface ReasoningItem {
  type: 'reasoning';
  id: string;
  summary: string[];
  content: string[];
}

export interface CommandExecutionItem {
  type: 'commandExecution';
  id: string;
  command: string;
  cwd: string;
  processId: string | null;
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
  status?: string;
}

export interface FileChangeEntry {
  path: string;
  type?: string;
  kind?: string | { type?: string; move_path?: string | null };
  diff?: string;
}

export interface FileChangePatchUpdatedNotification {
  threadId: string;
  turnId: string;
  itemId: string;
  changes: FileChangeEntry[];
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
  queries?: string[];
  url?: string;
  pattern?: string;
  action?: {
    type?: string;
    query?: string | null;
    queries?: string[] | null;
    url?: string | null;
    pattern?: string | null;
  } | null;
  /** Opaque structured sources, e.g. `{ title, url, snippet }` text results. */
  results?: unknown[] | null;
  status?: string;
}

export interface SubAgentActivityItem {
  type: 'subAgentActivity';
  id: string;
  kind: 'started' | 'interacted' | 'interrupted' | 'completed';
  agentThreadId: string;
  agentPath: string;
}

export interface CollabAgentToolCallItem {
  type: 'collabAgentToolCall';
  id: string;
  tool: string;
  status?: string;
  arguments?: Record<string, unknown>;
  result?: unknown;
  senderThreadId?: string;
  receiverThreadIds?: string[];
  prompt?: string | null;
  model?: string | null;
  reasoningEffort?: string | null;
  agentsStates?: Partial<Record<string, { status: string; message: string | null }>>;
}

export interface MCPToolCallItem {
  type: 'mcpToolCall';
  id: string;
  server: string;
  tool: string;
  status?: string;
  /** JSON value; some servers report the raw argument string. */
  arguments?: unknown;
  result?: { content?: unknown[]; structuredContent?: unknown } | null;
  error?: { message: string } | string | null;
  durationMs?: number | null;
}

export interface DynamicToolCallItem {
  type: 'dynamicToolCall';
  id: string;
  namespace?: string | null;
  tool: string;
  arguments: unknown;
  status: 'inProgress' | 'completed' | 'failed';
  contentItems?: DynamicToolCallOutputContentItem[] | null;
  success?: boolean | null;
  durationMs?: number | null;
}

/** Feedback hooks sent back into the running turn, such as a blocking Stop hook's reason. */
export interface HookPromptItem {
  type: 'hookPrompt';
  id: string;
  fragments: Array<{ text: string; hookRunId: string }>;
}

export interface ContextCompactionItem {
  type: 'contextCompaction';
  id: string;
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

export interface SkillInput {
  type: 'skill';
  name: string;
  path: string;
}

export interface MentionInput {
  type: 'mention';
  name: string;
  path: string;
}

export type UserInput = TextInput | LocalImageInput | SkillInput | MentionInput
  | { type: 'localAudio'; path: string }
  | ({ type: 'image' | 'audio' } & ({ url: string } | { fileId: string }));

// ---------------------------------------------------------------------------
// skills/list
// ---------------------------------------------------------------------------

export type SkillScope = 'user' | 'repo' | 'system' | 'admin';

export interface SkillInterface {
  displayName?: string;
  shortDescription?: string;
}

export interface SkillMetadata {
  name: string;
  description: string;
  shortDescription?: string;
  interface?: SkillInterface;
  path: string;
  scope: SkillScope;
  enabled: boolean;
}

export interface SkillErrorInfo {
  path: string;
  message: string;
}

export interface SkillsListEntry {
  cwd: string;
  skills: SkillMetadata[];
  errors: SkillErrorInfo[];
}

export interface SkillsListResult {
  data: SkillsListEntry[];
}

// ---------------------------------------------------------------------------
// model/list
// ---------------------------------------------------------------------------

export interface ModelReasoningEffortOption {
  reasoningEffort: string;
  description: string;
}

export interface ModelServiceTier {
  id: string;
  name: string;
  description: string;
}

export interface AppServerModel {
  id: string;
  model: string;
  displayName: string;
  description: string;
  hidden: boolean;
  supportedReasoningEfforts: ModelReasoningEffortOption[];
  defaultReasoningEffort: string;
  inputModalities?: Array<'text' | 'image' | 'audio'>;
  supportsPersonality?: boolean;
  serviceTiers?: ModelServiceTier[];
  defaultServiceTier?: string | null;
  isDefault: boolean;
}

export interface ModelListResult {
  data: AppServerModel[];
  nextCursor?: string | null;
}

// ---------------------------------------------------------------------------
// config/read
// ---------------------------------------------------------------------------

export interface ConfigReadParams {
  cwd?: string | null;
  includeLayers?: boolean;
}

export interface ConfigReadResult {
  config: {
    sandbox_workspace_write?: {
      writable_roots?: string[];
      network_access?: boolean;
      exclude_tmpdir_env_var?: boolean;
      exclude_slash_tmp?: boolean;
    } | null;
  };
}

export interface DynamicToolFunctionSpec {
  type: 'function';
  name: string;
  description: string;
  inputSchema: unknown;
  deferLoading?: boolean;
}

/**
 * Flat dynamic-tool request shape accepted by Codex before explicit namespace
 * specs and retained as a backwards-compatible input by current app servers.
 */
export interface LegacyDynamicToolSpec {
  namespace?: string | null;
  name: string;
  description: string;
  inputSchema: unknown;
  deferLoading?: boolean;
}

export interface DynamicToolCallParams {
  threadId: string;
  turnId: string;
  callId: string;
  namespace?: string | null;
  tool: string;
  arguments: unknown;
}

export type DynamicToolCallOutputContentItem =
  | { type: 'inputText'; text: string }
  | { type: 'inputImage'; imageUrl: string }
  | { type: 'inputAudio'; audioUrl: string };

export interface DynamicToolCallResponse {
  success: boolean;
  contentItems: DynamicToolCallOutputContentItem[];
}

export interface ThreadStartResult {
  thread: Thread;
  model: string;
  modelProvider: string;
  serviceTier: string | null;
  cwd: string;
  approvalPolicy: string | { granular: {
    sandbox_approval: boolean; rules: boolean; skill_approval: boolean;
    request_permissions: boolean; mcp_elicitations: boolean;
  } };
  approvalsReviewer: string;
  sandbox: SandboxPolicy;
  reasoningEffort: string | null;
}

export interface ThreadReadResult {
  thread: Thread;
}

export type SandboxPolicy =
  | { type: 'dangerFullAccess' }
  | {
    type: 'workspaceWrite';
    writableRoots?: string[];
    networkAccess?: boolean;
    excludeTmpdirEnvVar?: boolean;
    excludeSlashTmp?: boolean;
  }
  | {
    type: 'readOnly';
    access?: { type: string };
    networkAccess?: boolean;
  }
  | {
    type: 'externalSandbox';
    networkAccess: string;
  };

export type ThreadResumeResult = ThreadStartResult;

export type ThreadForkResult = ThreadStartResult;

export interface ThreadRevertResult {
  thread: Thread;
}

export type ThreadCompactStartResult = Record<string, never>;

export interface TurnStartResult {
  turn: Turn;
}

export interface TurnSteerResult {
  turnId: string;
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

export type GuardianReviewAction =
  | { type: 'command'; source: 'shell' | 'unifiedExec'; command: string; cwd: string }
  | { type: 'execve'; source: 'shell' | 'unifiedExec'; program: string; argv: string[]; cwd: string }
  | { type: 'writeStdin'; approvalId: string; processId: string; stdin: string; cwd: string }
  | { type: 'applyPatch'; cwd: string; files: string[] }
  | { type: 'networkAccess'; target: string; host: string; protocol: 'http' | 'https' | 'socks5Tcp' | 'socks5Udp'; port: number }
  | { type: 'mcpToolCall'; server: string; toolName: string; connectorId: string | null; connectorName: string | null; toolTitle: string | null }
  | { type: 'requestPermissions'; reason: string | null; permissions: RequestPermissionProfile };

export interface GuardianReviewStarted {
  threadId: string;
  turnId: string;
  startedAtMs: number;
  reviewId: string;
  targetItemId: string | null;
  action: GuardianReviewAction;
  review: {
    status: 'inProgress' | 'approved' | 'denied' | 'timedOut' | 'aborted';
    riskLevel: 'low' | 'medium' | 'high' | 'critical' | null;
    userAuthorization: 'unknown' | 'low' | 'medium' | 'high' | null;
    rationale: string | null;
  };
}

export interface GuardianReviewCompleted extends GuardianReviewStarted {
  completedAtMs: number;
  decisionSource: 'agent';
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
    modelContextWindow: number | null;
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

export type RequestId = string | number;

export interface ServerRequestResolvedNotification {
  threadId: string;
  requestId: RequestId;
}

// ---------------------------------------------------------------------------
// Server requests (require client response)
// ---------------------------------------------------------------------------

// -- Command execution approval (item/commandExecution/requestApproval) ------

export interface CommandApprovalRequest {
  threadId: string;
  turnId: string;
  itemId: string;
  kind?: 'command' | 'humanCommand' | 'writeStdin';
  startedAtMs?: number;
  environmentId?: string | null;
  command?: string | null;
  cwd?: string | null;
  reason?: string | null;
  commandActions?: CommandAction[] | null;
  approvalId?: string | null;
  networkApprovalContext?: {
    host: string;
    protocol: string;
  } | null;
  additionalPermissions?: AdditionalPermissionProfile | null;
  skillMetadata?: { pathToSkillsMd: string } | null;
  proposedExecpolicyAmendment?: string[] | null;
  proposedNetworkPolicyAmendments?: Array<{
    host: string;
    action: 'allow' | 'deny';
  }> | null;
  availableDecisions?: CommandExecutionApprovalDecision[] | null;
}

export type CommandExecutionApprovalDecision =
  | 'accept'
  | 'acceptForSession'
  | { acceptWithExecpolicyAmendment: { execpolicy_amendment: string[] } }
  | { applyNetworkPolicyAmendment: { network_policy_amendment: { host: string; action: 'allow' | 'deny' } } }
  | 'decline'
  | 'cancel';

export interface CommandExecutionApprovalResponse {
  decision: CommandExecutionApprovalDecision;
}

// -- File change approval (item/fileChange/requestApproval) ------------------

export interface FileChangeApprovalRequest {
  startedAtMs?: number;
  threadId: string;
  turnId: string;
  itemId: string;
  reason?: string | null;
  grantRoot?: string | null;
}

export type FileChangeApprovalDecision =
  | 'accept'
  | 'acceptForSession'
  | 'decline'
  | 'cancel';

export interface FileChangeApprovalResponse {
  decision: FileChangeApprovalDecision;
}

// -- Permissions approval (item/permissions/requestApproval) -----------------

export interface AdditionalFileSystemPermissions {
  /** Codex 0.171 deprecates `read`/`write` in favor of `entries`. */
  read?: string[] | null;
  write?: string[] | null;
  globScanMaxDepth?: number | null;
  entries?: FileSystemSandboxEntry[] | null;
}

export interface FileSystemSandboxEntry {
  path: FileSystemPath;
  access: 'read' | 'write' | 'deny';
}

export type FileSystemPath =
  | { type: 'path'; path: string }
  | { type: 'glob_pattern'; pattern: string }
  | { type: 'special'; value: FileSystemSpecialPath };

export type FileSystemSpecialPath =
  | { kind: 'root' }
  | { kind: 'minimal' }
  | { kind: 'project_roots'; subpath: string | null }
  | { kind: 'tmpdir' }
  | { kind: 'slash_tmp' }
  | { kind: 'unknown'; path: string; subpath: string | null };

export interface AdditionalNetworkPermissions {
  enabled?: boolean | null;
}

export interface AdditionalPermissionProfile {
  fileSystem?: AdditionalFileSystemPermissions | null;
  network?: AdditionalNetworkPermissions | null;
  macos?: Record<string, unknown> | null;
}

export interface RequestPermissionProfile {
  fileSystem?: AdditionalFileSystemPermissions | null;
  network?: AdditionalNetworkPermissions | null;
}

export interface GrantedPermissionProfile {
  fileSystem?: AdditionalFileSystemPermissions | null;
  network?: AdditionalNetworkPermissions | null;
}

export type PermissionGrantScope = 'turn' | 'session';

export interface PermissionsApprovalRequest {
  startedAtMs?: number;
  environmentId?: string | null;
  cwd?: string;
  threadId: string;
  turnId: string;
  itemId: string;
  permissions: RequestPermissionProfile;
  reason?: string | null;
}

export interface PermissionsApprovalResponse {
  permissions: GrantedPermissionProfile;
  scope: PermissionGrantScope;
  strictAutoReview?: boolean;
}

// -- MCP elicitation (mcpServer/elicitation/request) -------------------------

export type MCPElicitationRequest = {
  threadId: string;
  turnId: string | null;
  serverName: string;
  mode: 'openai/userVerification';
  title: string;
  description: string;
  challenge: string;
} | MCPMessageElicitationRequest;

export interface MCPMessageElicitationRequest {
  threadId: string;
  turnId: string | null;
  serverName: string;
  mode: 'form' | 'openai/form' | 'openaiForm' | 'url';
  message: string;
  requestedSchema?: unknown;
}

export interface MCPElicitationResponse {
  action: 'accept' | 'decline' | 'cancel';
  content: Record<string, unknown> | null;
}

// -- Tool request user input (item/tool/requestUserInput) --------------------

export interface UserInputQuestionOption {
  label: string;
  description: string;
}

export interface UserInputQuestion {
  id: string;
  header: string;
  question: string;
  options: UserInputQuestionOption[] | null;
  isOther: boolean;
  isSecret: boolean;
}

export interface UserInputRequest {
  threadId: string;
  turnId: string;
  itemId: string;
  questions: UserInputQuestion[];
}

export interface UserInputResponse {
  answers: Record<string, { answers: string[] }>;
}
