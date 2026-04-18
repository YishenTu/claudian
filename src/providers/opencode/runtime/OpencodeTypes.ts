export interface InitializeParams {
  protocolVersion: number;
  clientInfo: {
    name: string;
    version: string;
  };
  clientCapabilities?: {
    fs?: { readTextFile?: boolean; writeTextFile?: boolean };
    terminal?: boolean;
  };
}

export interface InitializeResult {
  protocolVersion: number;
  agentCapabilities: AgentCapabilities;
  agentInfo: { name: string; version: string };
  authMethods: AuthMethod[];
}

export interface AgentCapabilities {
  loadSession?: boolean;
  mcpCapabilities?: { http?: boolean; sse?: boolean };
  promptCapabilities?: {
    embeddedContext?: boolean;
    image?: boolean;
  };
  sessionCapabilities?: {
    fork?: Record<string, unknown>;
    list?: Record<string, unknown>;
    resume?: Record<string, unknown>;
  };
}

export interface AuthMethod {
  id: string;
  name: string;
  description?: string;
}

export interface NewSessionResponse {
  sessionId: string;
  configOptions?: SessionConfigOption[];
  modes?: {
    availableModes: ModeOption[];
    currentModeId?: string;
  };
}

export interface SessionConfigOption {
  id: string;
  name: string;
  category: string;
  type: string;
  currentValue: string;
  options: { value: string; name: string; description?: string }[];
}

export interface ModeOption {
  id: string;
  name: string;
  description?: string;
}

export interface PromptParams {
  sessionId: string;
  prompt: Array<{ type: string; text?: string; uri?: string; mimeType?: string; data?: string }>;
  model?: { providerID?: string; modelID?: string };
}

export interface PromptResult {
  stopReason: string;
  usage?: {
    totalTokens: number;
    inputTokens: number;
    outputTokens: number;
  };
}

export interface SessionUpdateNotification {
  sessionId: string;
  update: {
    sessionUpdate: string;
    [key: string]: unknown;
  };
}

export interface AgentMessageChunkNotification {
  sessionId: string;
  messageId: string;
  delta: string;
}

export interface ToolCallNotification {
  sessionId: string;
  toolCallId: string;
  title: string;
  kind: string;
  status: 'pending' | 'in_progress' | 'completed' | 'failed';
  locations?: { path: string }[];
  rawInput?: Record<string, unknown>;
  content?: Array<{ type: string; content: { type: string; text: string } }>;
  rawOutput?: {
    output?: string;
    metadata?: Record<string, unknown>;
    error?: string;
  };
}

export interface PermissionRequest {
  sessionId: string;
  toolCall: {
    toolCallId: string;
    status: string;
    title: string;
    rawInput?: Record<string, unknown>;
    kind: string;
    locations?: { path: string }[];
  };
  options: { optionId: string; kind: string; name: string }[];
}

export interface LoadSessionResponse {
  sessionId: string;
  configOptions?: SessionConfigOption[];
  modes?: {
    availableModes: ModeOption[];
    currentModeId?: string;
  };
}

export interface ForkSessionResponse {
  sessionId: string;
  configOptions?: SessionConfigOption[];
  modes?: {
    availableModes: ModeOption[];
    currentModeId?: string;
  };
}
