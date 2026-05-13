export const ACP_PROTOCOL_VERSION = 1 as const;

export type AcpProtocolVersion = typeof ACP_PROTOCOL_VERSION;
export type AcpRequestId = number | string | null;
export type AcpSessionId = string;
export type AcpSessionModeId = string;
export type AcpSessionConfigId = string;
export type AcpSessionConfigValueId = string;
export type AcpToolCallId = string;
export type AcpPermissionOptionId = string;
export type AcpPositionEncodingKind = 'utf-16' | 'utf-32' | 'utf-8';
export type AcpRole = 'assistant' | 'user';
export type AcpStopReason = string;

export interface AcpImplementation {
  name: string;
  version: string;
  title?: string | null;
}

export interface AcpAuthEnvVar {
  name: string;
  label?: string | null;
  optional?: boolean;
  secret?: boolean;
}

export type AcpAuthMethod = {
  description?: string | null;
  id: string;
  name?: string | null;
} & (
  | { type?: 'agent' }
  | { envVars: AcpAuthEnvVar[]; type: 'env_var' }
  | { args?: string[]; command: string; type: 'terminal' }
);

export interface AcpFileSystemCapabilities {
  readTextFile?: boolean;
  writeTextFile?: boolean;
}

export interface AcpClientAuthCapabilities {
  terminal?: boolean;
}

export interface AcpClientCapabilities {
  auth?: AcpClientAuthCapabilities;
  fs?: AcpFileSystemCapabilities;
  terminal?: boolean;
  positionEncodings?: AcpPositionEncodingKind[];
}

export interface AcpPromptCapabilities {
  audio?: boolean;
  embeddedContext?: boolean;
  image?: boolean;
}

export interface AcpMcpCapabilities {
  http?: boolean;
  sse?: boolean;
}

export interface AcpSessionCapabilities {
  close?: Record<string, never> | null;
  fork?: Record<string, never> | null;
  list?: Record<string, never> | null;
  resume?: Record<string, never> | null;
}

export interface AcpAgentCapabilities {
  auth?: {
    logout?: Record<string, never> | null;
  };
  loadSession?: boolean;
  mcpCapabilities?: AcpMcpCapabilities;
  positionEncoding?: AcpPositionEncodingKind | null;
  promptCapabilities?: AcpPromptCapabilities;
  sessionCapabilities?: AcpSessionCapabilities;
}

export interface AcpInitializeRequest {
  clientCapabilities?: AcpClientCapabilities;
  clientInfo?: AcpImplementation | null;
  protocolVersion: AcpProtocolVersion;
}

export interface AcpInitializeResponse {
  agentCapabilities?: AcpAgentCapabilities;
  agentInfo?: AcpImplementation | null;
  authMethods?: AcpAuthMethod[];
  protocolVersion: AcpProtocolVersion;
}

export interface AcpAuthenticateRequest {
  methodId: string;
}

export type AcpAuthenticateResponse = Record<string, never>;

export interface AcpEnvVariable {
  name: string;
  value: string;
}

export interface AcpHttpHeader {
  name: string;
  value: string;
}

export type AcpMcpServer =
  | {
    type: 'http';
    headers?: AcpHttpHeader[];
    name: string;
    url: string;
  }
  | {
    type: 'sse';
    headers?: AcpHttpHeader[];
    name: string;
    url: string;
  }
  | {
    type?: 'stdio';
    args: string[];
    command: string;
    env?: AcpEnvVariable[];
    name: string;
  };

export interface AcpSessionMode {
  description?: string | null;
  id: AcpSessionModeId;
  name: string;
}

export interface AcpSessionModeState {
  availableModes: AcpSessionMode[];
  currentModeId: AcpSessionModeId;
}

export interface AcpModelInfo {
  id: string;
  name: string;
  description?: string | null;
}

export interface AcpSessionModelState {
  availableModels: AcpModelInfo[];
  currentModelId: string;
}

export interface AcpSessionConfigSelectOption {
  description?: string | null;
  name: string;
  value: AcpSessionConfigValueId;
}

export interface AcpSessionConfigSelectGroup {
  group: string;
  name: string;
  options: AcpSessionConfigSelectOption[];
}

export type AcpSessionConfigSelectOptions =
  | AcpSessionConfigSelectOption[]
  | AcpSessionConfigSelectGroup[];

export type AcpSessionConfigOption = {
  category?: string | null;
  description?: string | null;
  id: AcpSessionConfigId;
  name: string;
} & (
  | { type: 'boolean'; value: boolean }
  | {
    currentValue: AcpSessionConfigValueId;
    options: AcpSessionConfigSelectOptions;
    type: 'select';
  }
);

export interface AcpNewSessionRequest {
  additionalDirectories?: string[];
  cwd: string;
  mcpServers: AcpMcpServer[];
}

export interface AcpNewSessionResponse {
  configOptions?: AcpSessionConfigOption[] | null;
  models?: AcpSessionModelState | null;
  modes?: AcpSessionModeState | null;
  sessionId: AcpSessionId;
}

export interface AcpLoadSessionRequest {
  additionalDirectories?: string[];
  cwd: string;
  mcpServers: AcpMcpServer[];
  sessionId: AcpSessionId;
}

export interface AcpLoadSessionResponse {
  configOptions?: AcpSessionConfigOption[] | null;
  models?: AcpSessionModelState | null;
  modes?: AcpSessionModeState | null;
  sessionId: AcpSessionId;
}

export interface AcpListSessionsRequest {
  additionalDirectories?: string[];
  cursor?: string | null;
  cwd?: string | null;
}

export interface AcpSessionInfo {
  sessionId: AcpSessionId;
  title?: string | null;
  updatedAt?: string | null;
}

export interface AcpListSessionsResponse {
  nextCursor?: string | null;
  sessions: AcpSessionInfo[];
}

export interface AcpTextContent {
  type: 'text';
  text: string;
}

export interface AcpImageContent {
  data: string;
  mimeType: string;
  type: 'image';
  uri?: string | null;
}

export interface AcpAudioContent {
  data: string;
  mimeType: string;
  type: 'audio';
}

export interface AcpResourceLink {
  description?: string | null;
  mimeType?: string | null;
  name: string;
  size?: number | null;
  title?: string | null;
  type: 'resource_link';
  uri: string;
}

export type AcpEmbeddedResource =
  | {
    resource: {
      mimeType?: string | null;
      text: string;
      uri: string;
    };
    type: 'resource';
  }
  | {
    resource: {
      blob: string;
      mimeType?: string | null;
      uri: string;
    };
    type: 'resource';
  };

export type AcpContentBlock =
  | AcpTextContent
  | AcpImageContent
  | AcpAudioContent
  | AcpResourceLink
  | AcpEmbeddedResource;

export interface AcpPromptRequest {
  messageId?: string | null;
  prompt: AcpContentBlock[];
  sessionId: AcpSessionId;
}

export interface AcpUsage {
  cachedReadTokens?: number | null;
  cachedWriteTokens?: number | null;
  inputTokens: number;
  outputTokens: number;
  thoughtTokens?: number | null;
  totalTokens: number;
}

export interface AcpPromptResponse {
  stopReason: AcpStopReason;
  usage?: AcpUsage | null;
  userMessageId?: string | null;
}

export interface AcpCancelNotification {
  sessionId: AcpSessionId;
}

export interface AcpSetSessionModeRequest {
  modeId: AcpSessionModeId;
  sessionId: AcpSessionId;
}

export type AcpSetSessionModeResponse = Record<string, never>;

export type AcpSetSessionConfigOptionRequest =
  | {
    configId: AcpSessionConfigId;
    sessionId: AcpSessionId;
    type: 'boolean';
    value: boolean;
  }
  | {
    configId: AcpSessionConfigId;
    sessionId: AcpSessionId;
    type: 'select';
    value: AcpSessionConfigValueId;
  };

export interface AcpSetSessionConfigOptionResponse {
  configOptions: AcpSessionConfigOption[];
}

export interface AcpContentChunk {
  content: AcpContentBlock;
  messageId?: string | null;
}

export type AcpToolKind =
  | 'read'
  | 'edit'
  | 'delete'
  | 'move'
  | 'search'
  | 'execute'
  | 'think'
  | 'fetch'
  | 'switch_mode'
  | 'other';

export type AcpToolCallStatus = 'pending' | 'in_progress' | 'completed' | 'failed';

export interface AcpDiffToolContent {
  newText: string;
  oldText?: string | null;
  path: string;
  type: 'diff';
}

export interface AcpTerminalToolContent {
  terminalId: string;
  type: 'terminal';
}

export interface AcpWrappedContentToolContent {
  content: AcpContentBlock;
  type: 'content';
}

export type AcpToolCallContent =
  | AcpDiffToolContent
  | AcpTerminalToolContent
  | AcpWrappedContentToolContent;

export interface AcpToolCallLocation {
  line?: number | null;
  path: string;
}

export interface AcpToolCall {
  content?: AcpToolCallContent[];
  kind?: AcpToolKind | null;
  locations?: AcpToolCallLocation[];
  rawInput?: unknown;
  rawOutput?: unknown;
  status?: AcpToolCallStatus | null;
  title: string;
  toolCallId: AcpToolCallId;
}

export interface AcpToolCallUpdate {
  content?: AcpToolCallContent[] | null;
  kind?: AcpToolKind | null;
  locations?: AcpToolCallLocation[] | null;
  rawInput?: unknown;
  rawOutput?: unknown;
  status?: AcpToolCallStatus | null;
  title?: string | null;
  toolCallId: AcpToolCallId;
}

export type AcpPlanEntryPriority = 'high' | 'medium' | 'low';
export type AcpPlanEntryStatus = 'pending' | 'in_progress' | 'completed';

export interface AcpPlanEntry {
  content: string;
  priority: AcpPlanEntryPriority;
  status: AcpPlanEntryStatus;
}

export interface AcpPlan {
  entries: AcpPlanEntry[];
}

export interface AcpAvailableCommandInput {
  hint: string;
}

export interface AcpAvailableCommand {
  description?: string | null;
  input?: AcpAvailableCommandInput | null;
  name: string;
}

export interface AcpAvailableCommandsUpdate {
  availableCommands: AcpAvailableCommand[];
}

export interface AcpCurrentModeUpdate {
  currentModeId: AcpSessionModeId;
}

export interface AcpConfigOptionUpdate {
  configOptions: AcpSessionConfigOption[];
}

export interface AcpSessionInfoUpdate {
  title?: string | null;
  updatedAt?: string | null;
}

export interface AcpUsageUpdate {
  cost?: {
    amount: number;
    currency: string;
  } | null;
  size: number;
  used: number;
}

export type AcpSessionUpdate =
  | (AcpContentChunk & { sessionUpdate: 'user_message_chunk' })
  | (AcpContentChunk & { sessionUpdate: 'agent_message_chunk' })
  | (AcpContentChunk & { sessionUpdate: 'agent_thought_chunk' })
  | (AcpToolCall & { sessionUpdate: 'tool_call' })
  | (AcpToolCallUpdate & { sessionUpdate: 'tool_call_update' })
  | (AcpPlan & { sessionUpdate: 'plan' })
  | (AcpAvailableCommandsUpdate & { sessionUpdate: 'available_commands_update' })
  | (AcpCurrentModeUpdate & { sessionUpdate: 'current_mode_update' })
  | (AcpConfigOptionUpdate & { sessionUpdate: 'config_option_update' })
  | (AcpSessionInfoUpdate & { sessionUpdate: 'session_info_update' })
  | (AcpUsageUpdate & { sessionUpdate: 'usage_update' });

export interface AcpSessionNotification {
  sessionId: AcpSessionId;
  update: AcpSessionUpdate;
}

export type AcpPermissionOptionKind =
  | 'allow_once'
  | 'allow_always'
  | 'reject_once'
  | 'reject_always';

export interface AcpPermissionOption {
  kind: AcpPermissionOptionKind;
  name: string;
  optionId: AcpPermissionOptionId;
}

export interface AcpRequestPermissionRequest {
  options: AcpPermissionOption[];
  sessionId: AcpSessionId;
  toolCall: AcpToolCallUpdate;
}

export type AcpRequestPermissionResponse = {
  outcome:
    | {
      outcome: 'cancelled';
    }
    | {
      optionId: AcpPermissionOptionId;
      outcome: 'selected';
    };
};

export interface AcpReadTextFileRequest {
  limit?: number | null;
  line?: number | null;
  path: string;
  sessionId: AcpSessionId;
}

export interface AcpReadTextFileResponse {
  content: string;
}

export interface AcpWriteTextFileRequest {
  content: string;
  path: string;
  sessionId: AcpSessionId;
}

export type AcpWriteTextFileResponse = Record<string, never>;

export interface AcpCreateTerminalRequest {
  args?: string[];
  command: string;
  cwd?: string | null;
  env?: AcpEnvVariable[];
  outputByteLimit?: number | null;
  sessionId: AcpSessionId;
}

export interface AcpCreateTerminalResponse {
  terminalId: string;
}

export interface AcpTerminalOutputRequest {
  sessionId: AcpSessionId;
  terminalId: string;
}

export interface AcpTerminalExitStatus {
  exitCode?: number | null;
  signal?: string | null;
}

export interface AcpTerminalOutputResponse {
  exitStatus?: AcpTerminalExitStatus | null;
  output: string;
  truncated: boolean;
}

export interface AcpWaitForTerminalExitRequest {
  sessionId: AcpSessionId;
  terminalId: string;
}

export interface AcpWaitForTerminalExitResponse {
  exitCode?: number | null;
  signal?: string | null;
}

export interface AcpKillTerminalRequest {
  sessionId: AcpSessionId;
  terminalId: string;
}

export type AcpKillTerminalResponse = Record<string, never>;

export interface AcpReleaseTerminalRequest {
  sessionId: AcpSessionId;
  terminalId: string;
}

export type AcpReleaseTerminalResponse = Record<string, never>;
