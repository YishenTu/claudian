import {
  type SessionToolName,
  TOOL_CLAUDIAN_LIST_SESSIONS,
  TOOL_CLAUDIAN_SEND_MESSAGE,
} from '@/core/tools/toolNames';

export type SessionToolSessionStatus = 'idle' | 'running' | 'awaiting-user';

export interface SessionToolSessionSummary {
  readonly sessionId: string;
  readonly title: string;
  readonly provider: string;
  readonly status: SessionToolSessionStatus;
  /** Informational only: the focused view's active conversation. Never used for routing. */
  readonly active: boolean;
}

export interface SessionToolSendMessageArgs {
  /** Omitted to create a new session. */
  readonly sessionId?: string;
  readonly text: string;
  /** New sessions only. */
  readonly provider?: string;
  /** New sessions only. */
  readonly model?: string;
}

/** `started` and `queued` both report mailbox admission, never provider acceptance or completion. */
export type SessionToolDeliveryStatus = 'started' | 'queued';

export interface SessionToolSendMessageResult {
  readonly sessionId: string;
  readonly status: SessionToolDeliveryStatus;
}

export type SessionToolCall =
  | { readonly tool: typeof TOOL_CLAUDIAN_LIST_SESSIONS }
  | { readonly tool: typeof TOOL_CLAUDIAN_SEND_MESSAGE; readonly args: SessionToolSendMessageArgs };

export type SessionToolCallDecodeResult =
  | { readonly ok: true; readonly call: SessionToolCall }
  | { readonly ok: false; readonly error: string };

/** Transport-neutral tool result; adapters translate it into their native tool output. */
export interface SessionToolResult {
  readonly isError: boolean;
  readonly text: string;
}

export interface SessionToolCallRequest {
  /** Unvalidated native tool name. */
  readonly name: string;
  /** Unvalidated native arguments. */
  readonly args: unknown;
  /** Aborted when the native caller cancels the call or disconnects. */
  readonly signal: AbortSignal;
  /** Native tool-use id, when the transport carries one. */
  readonly nativeToolUseId?: string;
}

export type SessionToolCallHandler = (request: SessionToolCallRequest) => Promise<SessionToolResult>;

interface SessionToolStringProperty {
  readonly type: 'string';
  readonly description: string;
}

export interface SessionToolInputSchema {
  readonly type: 'object';
  readonly properties: Readonly<Record<string, SessionToolStringProperty>>;
  readonly required?: readonly string[];
  readonly additionalProperties: false;
}

export interface SessionToolSpec {
  readonly name: SessionToolName;
  readonly description: string;
  readonly inputSchema: SessionToolInputSchema;
}

const SEND_MESSAGE_PROPERTIES = {
  sessionId: {
    type: 'string',
    description: `Recipient sessionId from ${TOOL_CLAUDIAN_LIST_SESSIONS}, or the session_id of a received message. Omit to create a new session.`,
  },
  text: {
    type: 'string',
    description: 'Message for the recipient. Include everything it needs; it cannot see this conversation.',
  },
  provider: {
    type: 'string',
    description: 'Provider for a new session. Only valid when sessionId is omitted; defaults to the user\'s default provider.',
  },
  model: {
    type: 'string',
    description: 'Model for a new session. Only valid when sessionId is omitted; defaults to the provider\'s default model.',
  },
} as const satisfies Record<string, SessionToolStringProperty>;

export const SESSION_TOOL_SPECS: readonly SessionToolSpec[] = [
  {
    name: TOOL_CLAUDIAN_LIST_SESSIONS,
    description: [
      'List the user\'s Claudian chat sessions that can receive messages.',
      'Returns a JSON array of {sessionId, title, provider, status, active}.',
      'status is "idle", "running", or "awaiting-user"; active marks the session the user is viewing.',
    ].join(' '),
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: TOOL_CLAUDIAN_SEND_MESSAGE,
    description: [
      'Send a message to another Claudian chat session, or omit sessionId to start a new one.',
      'The message starts a turn in the recipient, or queues until it is free.',
      'Returns {sessionId, status} immediately, where status is "started" or "queued"; it does not wait for the turn or a reply.',
      'A session cannot message itself.',
      'Messages from other sessions arrive wrapped in <session_message from="…" session_id="…">.',
      `Replying is optional: call ${TOOL_CLAUDIAN_SEND_MESSAGE} with that session_id only if a response is needed.`,
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: SEND_MESSAGE_PROPERTIES,
      required: ['text'],
      additionalProperties: false,
    },
  },
];

export function decodeSessionToolCall(name: string, args: unknown): SessionToolCallDecodeResult {
  if (name !== TOOL_CLAUDIAN_LIST_SESSIONS && name !== TOOL_CLAUDIAN_SEND_MESSAGE) {
    return { ok: false, error: `Unknown session tool "${name}".` };
  }
  const input = args ?? {};
  if (typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, error: 'Tool arguments must be an object.' };
  }
  const record = input as Record<string, unknown>;
  const properties = name === TOOL_CLAUDIAN_SEND_MESSAGE ? SEND_MESSAGE_PROPERTIES : {};
  const unexpected = Object.keys(record).find(key => !Object.hasOwn(properties, key));
  if (unexpected !== undefined) {
    return { ok: false, error: `Unexpected argument "${unexpected}".` };
  }
  if (name === TOOL_CLAUDIAN_LIST_SESSIONS) {
    return { ok: true, call: { tool: name } };
  }

  const sendArgs: { -readonly [K in keyof SessionToolSendMessageArgs]: SessionToolSendMessageArgs[K] } = { text: '' };
  for (const key of ['sessionId', 'text', 'provider', 'model'] as const) {
    const value = record[key];
    // Null is accepted as omitted: some native harnesses send null for absent optionals.
    if ((value === undefined || value === null) && key !== 'text') continue;
    if (typeof value !== 'string' || value.trim() === '') {
      return { ok: false, error: `"${key}" must be a non-empty string.` };
    }
    sendArgs[key] = value;
  }
  if (sendArgs.sessionId !== undefined && (sendArgs.provider !== undefined || sendArgs.model !== undefined)) {
    return { ok: false, error: '"provider" and "model" apply only when "sessionId" is omitted.' };
  }
  return { ok: true, call: { tool: name, args: sendArgs } };
}
