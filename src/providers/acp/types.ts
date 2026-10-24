export const ACP_PROTOCOL_VERSION = 1 as const;

export type ACPProtocolVersion = typeof ACP_PROTOCOL_VERSION;
export type ACPSessionId = string;
export type ACPSessionModeId = string;
export type ACPSessionConfigId = string;
export type ACPSessionConfigValueId = string;
export type ACPToolCallId = string;
export type ACPPermissionOptionId = string;
export type ACPStopReason = string;
export type ACPMetadata = Record<string, unknown>;

export interface ACPImplementation {
  name: string;
  version: string;
  title?: string | null;
}

export interface ACPInitializeRequest {
  clientInfo?: ACPImplementation | null;
  protocolVersion: ACPProtocolVersion;
}

/** Only provider extension metadata is read from agent capabilities. */
export interface ACPAgentCapabilities {
  _meta?: ACPMetadata | null;
}

export interface ACPInitializeResponse {
  _meta?: ACPMetadata | null;
  agentCapabilities?: ACPAgentCapabilities;
  protocolVersion: ACPProtocolVersion;
}

export interface ACPEnvVariable {
  name: string;
  value: string;
}

export interface ACPHTTPHeader {
  name: string;
  value: string;
}

export type ACPMCPServer =
  | {
    type: 'http';
    headers?: ACPHTTPHeader[];
    name: string;
    url: string;
  }
  | {
    type: 'sse';
    headers?: ACPHTTPHeader[];
    name: string;
    url: string;
  }
  | {
    type?: 'stdio';
    args: string[];
    command: string;
    env?: ACPEnvVariable[];
    name: string;
  };

export interface ACPSessionMode {
  description?: string | null;
  id: ACPSessionModeId;
  name: string;
}

export interface ACPSessionModeState {
  availableModes: ACPSessionMode[];
  currentModeId: ACPSessionModeId;
}

export type ACPModelInfo = {
  _meta?: ACPMetadata | null;
  name: string;
  description?: string | null;
} & (
  | { id?: string; modelId: string }
  | { id: string; modelId?: string }
);

export interface ACPSessionModelState {
  _meta?: ACPMetadata | null;
  availableModels: ACPModelInfo[];
  currentModelId: string;
}

export interface ACPSessionConfigSelectOption {
  description?: string | null;
  name: string;
  value: ACPSessionConfigValueId;
}

export interface ACPSessionConfigSelectGroup {
  group: string;
  name: string;
  options: ACPSessionConfigSelectOption[];
}

export type ACPSessionConfigSelectOptions =
  | ACPSessionConfigSelectOption[]
  | ACPSessionConfigSelectGroup[];

export type ACPSessionConfigOption = {
  category?: string | null;
  description?: string | null;
  id: ACPSessionConfigId;
  name: string;
} & (
  | { type: 'boolean'; value: boolean }
  | {
    currentValue: ACPSessionConfigValueId;
    options: ACPSessionConfigSelectOptions;
    type: 'select';
  }
);

export interface ACPNewSessionRequest {
  _meta?: ACPMetadata | null;
  additionalDirectories?: string[];
  cwd: string;
  mcpServers: ACPMCPServer[];
}

export interface ACPNewSessionResponse {
  _meta?: ACPMetadata | null;
  configOptions?: ACPSessionConfigOption[] | null;
  models?: ACPSessionModelState | null;
  modes?: ACPSessionModeState | null;
  sessionId: ACPSessionId;
}

export interface ACPLoadSessionRequest {
  _meta?: ACPMetadata | null;
  additionalDirectories?: string[];
  cwd: string;
  mcpServers: ACPMCPServer[];
  sessionId: ACPSessionId;
}

export interface ACPLoadSessionResponse {
  _meta?: ACPMetadata | null;
  configOptions?: ACPSessionConfigOption[] | null;
  models?: ACPSessionModelState | null;
  modes?: ACPSessionModeState | null;
  sessionId?: ACPSessionId | null;
}

export interface ACPTextContent {
  type: 'text';
  text: string;
}

export interface ACPImageContent {
  data: string;
  mimeType: string;
  type: 'image';
  uri?: string | null;
}

export interface ACPAudioContent {
  data: string;
  mimeType: string;
  type: 'audio';
}

export interface ACPResourceLink {
  description?: string | null;
  mimeType?: string | null;
  name: string;
  size?: number | null;
  title?: string | null;
  type: 'resource_link';
  uri: string;
}

export type ACPEmbeddedResource =
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

export type ACPContentBlock =
  | ACPTextContent
  | ACPImageContent
  | ACPAudioContent
  | ACPResourceLink
  | ACPEmbeddedResource;

export interface ACPPromptRequest {
  messageId?: string | null;
  prompt: ACPContentBlock[];
  sessionId: ACPSessionId;
}

export interface ACPUsage {
  cachedReadTokens?: number | null;
  cachedWriteTokens?: number | null;
  inputTokens: number;
  outputTokens: number;
  thoughtTokens?: number | null;
  totalTokens: number;
}

export interface ACPPromptResponse {
  stopReason: ACPStopReason;
  usage?: ACPUsage | null;
  userMessageId?: string | null;
}

export interface ACPCancelNotification {
  sessionId: ACPSessionId;
}

export interface ACPSetSessionModeRequest {
  modeId: ACPSessionModeId;
  sessionId: ACPSessionId;
}

export type ACPSetSessionModeResponse = Record<string, never>;

export interface ACPSetSessionModelRequest {
  _meta?: ACPMetadata | null;
  modelId: string;
  sessionId: ACPSessionId;
}

export interface ACPSetSessionModelResponse {
  _meta?: ACPMetadata | null;
}

export interface ACPContentChunk {
  content: ACPContentBlock;
  messageId?: string | null;
}

export type ACPToolKind =
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

export type ACPToolCallStatus = 'pending' | 'in_progress' | 'completed' | 'failed';

export interface ACPDiffToolContent {
  newText: string;
  oldText?: string | null;
  path: string;
  type: 'diff';
}

export interface ACPTerminalToolContent {
  terminalId: string;
  type: 'terminal';
}

export interface ACPWrappedContentToolContent {
  content: ACPContentBlock;
  type: 'content';
}

export type ACPToolCallContent =
  | ACPDiffToolContent
  | ACPTerminalToolContent
  | ACPWrappedContentToolContent;

export interface ACPToolCallLocation {
  line?: number | null;
  path: string;
}

export interface ACPToolCall {
  content?: ACPToolCallContent[];
  kind?: ACPToolKind | null;
  locations?: ACPToolCallLocation[];
  rawInput?: unknown;
  rawOutput?: unknown;
  status?: ACPToolCallStatus | null;
  title: string;
  toolCallId: ACPToolCallId;
}

export interface ACPToolCallUpdate {
  content?: ACPToolCallContent[] | null;
  kind?: ACPToolKind | null;
  locations?: ACPToolCallLocation[] | null;
  rawInput?: unknown;
  rawOutput?: unknown;
  status?: ACPToolCallStatus | null;
  title?: string | null;
  toolCallId: ACPToolCallId;
}

export type ACPPlanEntryPriority = 'high' | 'medium' | 'low';
export type ACPPlanEntryStatus = 'pending' | 'in_progress' | 'completed';

export interface ACPPlanEntry {
  content: string;
  priority: ACPPlanEntryPriority;
  status: ACPPlanEntryStatus;
}

export interface ACPPlan {
  entries: ACPPlanEntry[];
}

export interface ACPAvailableCommandInput {
  hint: string;
}

export interface ACPAvailableCommand {
  _meta?: ACPMetadata | null;
  description?: string | null;
  input?: ACPAvailableCommandInput | null;
  name: string;
}

export interface ACPAvailableCommandsUpdate {
  availableCommands: ACPAvailableCommand[];
}

export interface ACPCurrentModeUpdate {
  currentModeId: ACPSessionModeId;
}

export interface ACPConfigOptionUpdate {
  configOptions: ACPSessionConfigOption[];
}

export interface ACPSessionInfoUpdate {
  title?: string | null;
  updatedAt?: string | null;
}

export interface ACPUsageUpdate {
  cost?: {
    amount: number;
    currency: string;
  } | null;
  size: number;
  used: number;
}

export type ACPSessionUpdate = { _meta?: ACPMetadata | null } & (
  | (ACPContentChunk & { sessionUpdate: 'user_message_chunk' })
  | (ACPContentChunk & { sessionUpdate: 'agent_message_chunk' })
  | (ACPContentChunk & { sessionUpdate: 'agent_thought_chunk' })
  | (ACPToolCall & { sessionUpdate: 'tool_call' })
  | (ACPToolCallUpdate & { sessionUpdate: 'tool_call_update' })
  | (ACPPlan & { sessionUpdate: 'plan' })
  | (ACPAvailableCommandsUpdate & { sessionUpdate: 'available_commands_update' })
  | (ACPCurrentModeUpdate & { sessionUpdate: 'current_mode_update' })
  | (ACPConfigOptionUpdate & { sessionUpdate: 'config_option_update' })
  | (ACPSessionInfoUpdate & { sessionUpdate: 'session_info_update' })
  | (ACPUsageUpdate & { sessionUpdate: 'usage_update' })
);

export interface ACPSessionNotification {
  _meta?: ACPMetadata | null;
  sessionId: ACPSessionId;
  update: ACPSessionUpdate;
}

export type ACPPermissionOptionKind =
  | 'allow_once'
  | 'allow_always'
  | 'reject_once'
  | 'reject_always';

export interface ACPPermissionOption {
  kind: ACPPermissionOptionKind;
  name: string;
  optionId: ACPPermissionOptionId;
}

export interface ACPRequestPermissionRequest {
  options: ACPPermissionOption[];
  sessionId: ACPSessionId;
  toolCall: ACPToolCallUpdate;
}

export type ACPRequestPermissionResponse = {
  outcome:
    | {
      outcome: 'cancelled';
    }
    | {
      optionId: ACPPermissionOptionId;
      outcome: 'selected';
    };
};
