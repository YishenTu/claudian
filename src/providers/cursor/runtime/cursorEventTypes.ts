/**
 * Typed views over the NDJSON event stream emitted by `cursor-agent --print
 * --output-format stream-json --stream-partial-output`.
 *
 * The schema is documented from a real `cursor-agent` build (see
 * `tests/unit/providers/cursor/runtime/fixtures/`). Extra fields outside the
 * known shape are tolerated; the normalizer narrows by `type` + `subtype`.
 */

export interface CursorEventBase {
  type: string;
  session_id?: string;
}

export interface CursorSystemInitEvent extends CursorEventBase {
  type: 'system';
  subtype: 'init';
  apiKeySource?: string;
  cwd?: string;
  model?: string;
  permissionMode?: string;
}

export interface CursorTextContentBlock {
  type: 'text';
  text: string;
}

export type CursorContentBlock = CursorTextContentBlock | { type: string;[key: string]: unknown };

export interface CursorMessage {
  role: 'user' | 'assistant' | string;
  content: CursorContentBlock[];
}

export interface CursorUserMessageEvent extends CursorEventBase {
  type: 'user';
  message: CursorMessage;
}

export interface CursorAssistantMessageEvent extends CursorEventBase {
  type: 'assistant';
  message: CursorMessage;
  /** Present on partial deltas; absent on the final consolidated message. */
  timestamp_ms?: number;
}

export interface CursorThinkingDeltaEvent extends CursorEventBase {
  type: 'thinking';
  subtype: 'delta';
  text: string;
  timestamp_ms?: number;
}

export interface CursorThinkingCompletedEvent extends CursorEventBase {
  type: 'thinking';
  subtype: 'completed';
  timestamp_ms?: number;
}

export type CursorThinkingEvent = CursorThinkingDeltaEvent | CursorThinkingCompletedEvent;

export interface CursorShellToolCallArgs {
  command?: string;
  workingDirectory?: string;
  description?: string;
  [key: string]: unknown;
}

export interface CursorShellToolCallSuccessResult {
  command?: string;
  workingDirectory?: string;
  exitCode?: number;
  signal?: string;
  stdout?: string;
  stderr?: string;
  executionTime?: number;
}

export interface CursorShellToolCall {
  shellToolCall: {
    args: CursorShellToolCallArgs;
    description?: string;
    result?: {
      success?: CursorShellToolCallSuccessResult;
      error?: { message?: string;[key: string]: unknown };
      [key: string]: unknown;
    };
    [key: string]: unknown;
  };
}

export type CursorToolCallShape = CursorShellToolCall | Record<string, unknown>;

export interface CursorToolCallStartedEvent extends CursorEventBase {
  type: 'tool_call';
  subtype: 'started';
  call_id: string;
  tool_call: CursorToolCallShape;
  model_call_id?: string;
  timestamp_ms?: number;
}

export interface CursorToolCallCompletedEvent extends CursorEventBase {
  type: 'tool_call';
  subtype: 'completed';
  call_id: string;
  tool_call: CursorToolCallShape;
  model_call_id?: string;
  timestamp_ms?: number;
}

export type CursorToolCallEvent = CursorToolCallStartedEvent | CursorToolCallCompletedEvent;

export interface CursorUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

export interface CursorResultEvent extends CursorEventBase {
  type: 'result';
  subtype: 'success' | 'error' | string;
  duration_ms?: number;
  duration_api_ms?: number;
  is_error?: boolean;
  result?: string;
  request_id?: string;
  usage?: CursorUsage;
  /** Present on errored runs; the field name varies across versions. */
  error?: string | { message?: string };
}

export type CursorStreamEvent =
  | CursorSystemInitEvent
  | CursorUserMessageEvent
  | CursorAssistantMessageEvent
  | CursorThinkingEvent
  | CursorToolCallEvent
  | CursorResultEvent
  | CursorEventBase;

export function isCursorTextContentBlock(block: CursorContentBlock): block is CursorTextContentBlock {
  return block.type === 'text' && typeof (block as CursorTextContentBlock).text === 'string';
}

export function extractAssistantText(message: CursorMessage | undefined): string {
  if (!message?.content) {
    return '';
  }
  return message.content
    .filter(isCursorTextContentBlock)
    .map(block => block.text)
    .join('');
}
