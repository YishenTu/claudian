/**
 * Test helpers for building SDK-shaped messages.
 *
 * These types mirror the Gemini CLI JSONL output shapes used throughout tests.
 * No external SDK dependency required.
 */

// --- Local type definitions (replacing SDK imports) ---

export interface SDKSystemMessage {
  type: 'system';
  subtype: 'init';
  apiKeySource?: string;
  claude_code_version?: string;
  cwd?: string;
  tools?: string[];
  mcp_servers?: unknown[];
  model?: string;
  permissionMode?: string;
  slash_commands?: unknown[];
  output_style?: string;
  skills?: unknown[];
  plugins?: unknown[];
  uuid?: string;
  session_id?: string;
  [key: string]: unknown;
}

export interface SDKStatusMessage {
  type: 'system';
  subtype: 'status';
  status?: string | null;
  uuid?: string;
  session_id?: string;
  [key: string]: unknown;
}

export interface SDKCompactBoundaryMessage {
  type: 'system';
  subtype: 'compact_boundary';
  compact_metadata?: { trigger: string; pre_tokens: number };
  uuid?: string;
  session_id?: string;
  [key: string]: unknown;
}

export interface SDKAssistantMessage {
  type: 'assistant';
  message: { content: unknown[]; model?: string; [key: string]: unknown };
  parent_tool_use_id?: string | null;
  uuid?: string;
  session_id?: string;
  [key: string]: unknown;
}

export interface SDKUserMessage {
  type: 'user';
  message: { role?: string; content: unknown };
  parent_tool_use_id?: string | null;
  session_id?: string;
  [key: string]: unknown;
}

export interface SDKPartialAssistantMessage {
  type: 'stream_event';
  event: unknown;
  parent_tool_use_id?: string | null;
  uuid?: string;
  session_id?: string;
  [key: string]: unknown;
}

export interface SDKResultSuccess {
  type: 'result';
  subtype: 'success';
  duration_ms?: number;
  duration_api_ms?: number;
  is_error?: boolean;
  num_turns?: number;
  result?: string;
  stop_reason?: string | null;
  total_cost_usd?: number;
  usage?: { input_tokens: number; output_tokens: number; cache_creation_input_tokens: number; cache_read_input_tokens: number };
  modelUsage?: Record<string, unknown>;
  permission_denials?: unknown[];
  uuid?: string;
  session_id?: string;
  [key: string]: unknown;
}

export interface SDKResultError {
  type: 'result';
  subtype: 'error' | 'error_max_turns' | 'error_tool_use';
  duration_ms?: number;
  duration_api_ms?: number;
  is_error?: boolean;
  num_turns?: number;
  stop_reason?: string | null;
  total_cost_usd?: number;
  usage?: { input_tokens: number; output_tokens: number; cache_creation_input_tokens: number; cache_read_input_tokens: number };
  modelUsage?: Record<string, unknown>;
  permission_denials?: unknown[];
  errors?: string[];
  uuid?: string;
  session_id?: string;
  [key: string]: unknown;
}

export interface SDKToolProgressMessage {
  type: 'tool_progress';
  tool_use_id?: string;
  tool_name?: string;
  parent_tool_use_id?: string | null;
  elapsed_time_seconds?: number;
  uuid?: string;
  session_id?: string;
  [key: string]: unknown;
}

export interface SDKAuthStatusMessage {
  type: 'auth_status';
  isAuthenticating?: boolean;
  output?: unknown[];
  uuid?: string;
  session_id?: string;
  [key: string]: unknown;
}

export type SDKMessage =
  | SDKSystemMessage
  | SDKStatusMessage
  | SDKCompactBoundaryMessage
  | SDKAssistantMessage
  | SDKUserMessage
  | SDKPartialAssistantMessage
  | SDKResultSuccess
  | SDKResultError
  | SDKToolProgressMessage
  | SDKAuthStatusMessage;

// --- Constants ---

const TEST_UUID = '00000000-0000-4000-8000-000000000001';
const TEST_SESSION_ID = 'test-session';

const DEFAULT_RESULT_USAGE = {
  input_tokens: 0,
  output_tokens: 0,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
};

const DEFAULT_MODEL_USAGE: Record<string, unknown> = {
  'claude-sonnet-test': {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    webSearchRequests: 0,
    costUSD: 0,
    contextWindow: 200000,
    maxOutputTokens: 8192,
  },
};

// --- Input types for test builder ---

export type SystemInitMessageInput = {
  type: 'system';
  subtype: 'init';
} & Partial<Omit<SDKSystemMessage, 'type' | 'subtype'>>;

export type SystemStatusMessageInput = {
  type: 'system';
  subtype: 'status';
} & Partial<Omit<SDKStatusMessage, 'type' | 'subtype'>>;

export type CompactBoundaryMessageInput = {
  type: 'system';
  subtype: 'compact_boundary';
} & Partial<Omit<SDKCompactBoundaryMessage, 'type' | 'subtype'>>;

export type AssistantMessageInput = {
  type: 'assistant';
} & Partial<Omit<SDKAssistantMessage, 'type'>>;

export type UserMessageInput = {
  type: 'user';
  _blocked?: boolean;
  _blockReason?: string;
} & Partial<Omit<SDKUserMessage, 'type'>>;

export type StreamEventMessageInput = {
  type: 'stream_event';
} & Partial<Omit<SDKPartialAssistantMessage, 'type'>>;

export type ResultSuccessMessageInput = {
  type: 'result';
  subtype?: 'success';
} & Partial<Omit<SDKResultSuccess, 'type' | 'subtype'>>;

export type ResultErrorMessageInput = {
  type: 'result';
  subtype: SDKResultError['subtype'];
} & Partial<Omit<SDKResultError, 'type' | 'subtype'>>;

export type ToolProgressMessageInput = {
  type: 'tool_progress';
} & Partial<Omit<SDKToolProgressMessage, 'type'>>;

export type AuthStatusMessageInput = {
  type: 'auth_status';
} & Partial<Omit<SDKAuthStatusMessage, 'type'>>;

export type SDKTestMessageInput =
  | SystemInitMessageInput
  | SystemStatusMessageInput
  | CompactBoundaryMessageInput
  | AssistantMessageInput
  | UserMessageInput
  | StreamEventMessageInput
  | ResultSuccessMessageInput
  | ResultErrorMessageInput
  | ToolProgressMessageInput
  | AuthStatusMessageInput;

// --- Builder functions ---

export function buildSystemInitMessage(overrides: Partial<Omit<SDKSystemMessage, 'type' | 'subtype'>> = {}): SDKSystemMessage {
  return {
    type: 'system',
    subtype: 'init',
    apiKeySource: 'user',
    claude_code_version: 'test-version',
    cwd: '/test/cwd',
    tools: [],
    mcp_servers: [],
    model: 'claude-sonnet-4-5',
    permissionMode: 'default',
    slash_commands: [],
    output_style: 'default',
    skills: [],
    plugins: [],
    uuid: TEST_UUID,
    session_id: TEST_SESSION_ID,
    ...overrides,
  };
}

export function buildSystemStatusMessage(overrides: Partial<Omit<SDKStatusMessage, 'type' | 'subtype'>> = {}): SDKStatusMessage {
  return {
    type: 'system',
    subtype: 'status',
    status: null,
    uuid: TEST_UUID,
    session_id: TEST_SESSION_ID,
    ...overrides,
  };
}

export function buildCompactBoundaryMessage(
  overrides: Partial<Omit<SDKCompactBoundaryMessage, 'type' | 'subtype'>> = {}
): SDKCompactBoundaryMessage {
  return {
    type: 'system',
    subtype: 'compact_boundary',
    compact_metadata: {
      trigger: 'manual',
      pre_tokens: 0,
    },
    uuid: TEST_UUID,
    session_id: TEST_SESSION_ID,
    ...overrides,
  };
}

export function buildAssistantMessage(overrides: Partial<Omit<SDKAssistantMessage, 'type'>> = {}): SDKAssistantMessage {
  return {
    type: 'assistant',
    message: { content: [] },
    parent_tool_use_id: null,
    uuid: TEST_UUID,
    session_id: TEST_SESSION_ID,
    ...overrides,
  };
}

export function buildUserMessage(overrides: Partial<Omit<SDKUserMessage, 'type'>> = {}): SDKUserMessage {
  return {
    type: 'user',
    message: { content: [] },
    parent_tool_use_id: null,
    session_id: TEST_SESSION_ID,
    ...overrides,
  };
}

export function buildStreamEventMessage(
  overrides: Partial<Omit<SDKPartialAssistantMessage, 'type'>> = {}
): SDKPartialAssistantMessage {
  return {
    type: 'stream_event',
    event: {
      type: 'content_block_delta',
      delta: { type: 'text_delta', text: '' },
    },
    parent_tool_use_id: null,
    uuid: TEST_UUID,
    session_id: TEST_SESSION_ID,
    ...overrides,
  };
}

export function buildResultSuccessMessage(
  overrides: Partial<Omit<SDKResultSuccess, 'type' | 'subtype'>> = {}
): SDKResultSuccess {
  return {
    type: 'result',
    subtype: 'success',
    duration_ms: 0,
    duration_api_ms: 0,
    is_error: false,
    num_turns: 1,
    result: 'completed',
    stop_reason: null,
    total_cost_usd: 0,
    usage: DEFAULT_RESULT_USAGE,
    modelUsage: DEFAULT_MODEL_USAGE,
    permission_denials: [],
    uuid: TEST_UUID,
    session_id: TEST_SESSION_ID,
    ...overrides,
  };
}

export function buildResultErrorMessage(
  overrides: Partial<Omit<SDKResultError, 'type' | 'subtype'>> & Pick<SDKResultError, 'subtype'>
): SDKResultError {
  const { subtype, ...rest } = overrides;

  return {
    type: 'result',
    subtype,
    duration_ms: 0,
    duration_api_ms: 0,
    is_error: true,
    num_turns: 1,
    stop_reason: null,
    total_cost_usd: 0,
    usage: DEFAULT_RESULT_USAGE,
    modelUsage: DEFAULT_MODEL_USAGE,
    permission_denials: [],
    errors: ['SDK reported an execution error'],
    uuid: TEST_UUID,
    session_id: TEST_SESSION_ID,
    ...rest,
  };
}

export function buildToolProgressMessage(
  overrides: Partial<Omit<SDKToolProgressMessage, 'type'>> = {}
): SDKToolProgressMessage {
  return {
    type: 'tool_progress',
    tool_use_id: 'tool-1',
    tool_name: 'Bash',
    parent_tool_use_id: null,
    elapsed_time_seconds: 0,
    uuid: TEST_UUID,
    session_id: TEST_SESSION_ID,
    ...overrides,
  };
}

export function buildAuthStatusMessage(
  overrides: Partial<Omit<SDKAuthStatusMessage, 'type'>> = {}
): SDKAuthStatusMessage {
  return {
    type: 'auth_status',
    isAuthenticating: false,
    output: [],
    uuid: TEST_UUID,
    session_id: TEST_SESSION_ID,
    ...overrides,
  };
}

function isResultErrorInput(input: ResultSuccessMessageInput | ResultErrorMessageInput): input is ResultErrorMessageInput {
  return input.subtype !== undefined && input.subtype !== 'success';
}

export function buildSDKMessage(input: SDKTestMessageInput): SDKMessage {
  switch (input.type) {
    case 'system':
      if (input.subtype === 'init') return buildSystemInitMessage(input);
      if (input.subtype === 'status') return buildSystemStatusMessage(input);
      return buildCompactBoundaryMessage(input);
    case 'assistant':
      return buildAssistantMessage(input);
    case 'user': {
      const message = buildUserMessage(input);
      if (input._blocked === true) {
        return {
          ...message,
          _blocked: true,
          _blockReason: input._blockReason ?? 'Blocked by hook',
        } as SDKMessage;
      }
      return message;
    }
    case 'stream_event':
      return buildStreamEventMessage(input);
    case 'result':
      if (isResultErrorInput(input)) {
        return buildResultErrorMessage(input);
      }
      return buildResultSuccessMessage(input);
    case 'tool_progress':
      return buildToolProgressMessage(input);
    case 'auth_status':
      return buildAuthStatusMessage(input);
  }
}
