import {
  type SessionToolName,
  TOOL_CLAUDIAN_LIST_DESTINATIONS,
  TOOL_CLAUDIAN_READ_SESSION,
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
  /** Present only on the calling session's own row. */
  readonly self?: true;
}

export interface SessionToolListDestinationsArgs {
  readonly includeProviders: boolean;
  /** Maximum number of sessions, 1 to 200. */
  readonly limit: number;
}

export interface SessionToolReasoningDestination {
  readonly options: readonly string[];
  /** Level a new session would use when reasoning is omitted. */
  readonly default: string;
}

export interface SessionToolModelDestination {
  readonly id: string;
  /** Model a new session uses when provider and model are omitted. */
  readonly default?: true;
  /** Present only for models with reasoning effort control. */
  readonly reasoning?: SessionToolReasoningDestination;
}

export interface SessionToolProviderDestination {
  readonly provider: string;
  /** Provider a new session would use when provider is omitted. */
  readonly default?: true;
  readonly models: readonly SessionToolModelDestination[];
}

export interface SessionToolDestinations {
  /** Most recently active first, capped at the requested limit. */
  readonly sessions: readonly SessionToolSessionSummary[];
  /** Present when more sessions exist than the limit allowed. */
  readonly truncated?: true;
  /** Enabled providers; present only when requested. */
  readonly providers?: readonly SessionToolProviderDestination[];
}

/** How a message reaches a recipient; omitted means queue. */
export type SessionToolSendMode = 'steer' | 'interrupt';

export interface SessionToolSendMessageArgs {
  /** Omitted to create a new session. */
  readonly sessionId?: string;
  /** Required except for an interrupt that only stops the recipient. */
  readonly text?: string;
  /** Steer and interrupt need sessionId. */
  readonly mode?: SessionToolSendMode;
  /** New sessions only. */
  readonly provider?: string;
  /** Initial choice for a new session; a persistent switch for an existing one. */
  readonly model?: string;
  /** Initial choice for a new session; a persistent switch for an existing one. */
  readonly reasoning?: string;
}

/** `started` and `queued` report mailbox admission, never provider acceptance or completion. */
export type SessionToolDeliveryStatus = 'started' | 'queued';

/**
 * A send's outcome: mailbox admission, or `steered` (accepted into the running turn), `uncertain`
 * (a steer that may have arrived; never resent), `interrupted` (running work stopped; any message is
 * next) or `idle` (an interrupt without a message found nothing running).
 */
export type SessionToolSendStatus = SessionToolDeliveryStatus | 'steered' | 'uncertain' | 'interrupted' | 'idle';

export interface SessionToolSendMessageResult {
  readonly sessionId: string;
  /** Recipient title at admission. */
  readonly title: string;
  /** Recipient provider id. */
  readonly provider: string;
  readonly status: SessionToolSendStatus;
}

export interface SessionToolReadSessionArgs {
  readonly sessionId: string;
  /** Session turn number; only turns before it are returned. Omitted for the latest turns. */
  readonly beforeTurn?: number;
}

export interface SessionToolReadSessionResult {
  readonly sessionId: string;
  readonly title: string;
  readonly provider: string;
  readonly status: SessionToolSessionStatus;
  /** Markdown transcript: a header, then each returned turn's prompt and final reply. */
  readonly content: string;
  /** First and last returned turn numbers; both 0 when no turn is returned. */
  readonly fromTurn: number;
  readonly toTurn: number;
  /** Completed turns in the session; a running turn is not counted. */
  readonly totalTurns: number;
}

export type SessionToolCall =
  | { readonly tool: typeof TOOL_CLAUDIAN_LIST_DESTINATIONS; readonly args: SessionToolListDestinationsArgs }
  | { readonly tool: typeof TOOL_CLAUDIAN_SEND_MESSAGE; readonly args: SessionToolSendMessageArgs }
  | { readonly tool: typeof TOOL_CLAUDIAN_READ_SESSION; readonly args: SessionToolReadSessionArgs };

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

/** Plain type-and-description properties: some native schema dialects reject range keywords. */
interface SessionToolProperty {
  readonly type: 'string' | 'boolean' | 'integer';
  readonly description: string;
}

export interface SessionToolInputSchema {
  readonly type: 'object';
  readonly properties: Readonly<Record<string, SessionToolProperty>>;
  readonly required?: readonly string[];
  readonly additionalProperties: false;
}

export interface SessionToolSpec {
  readonly name: SessionToolName;
  readonly description: string;
  readonly inputSchema: SessionToolInputSchema;
}

const LIST_LIMIT_DEFAULT = 50;
const LIST_LIMIT_MAX = 200;
const LIST_OPTIONS_HINT = `Call ${TOOL_CLAUDIAN_LIST_DESTINATIONS} with includeProviders: true to see the options.`;

const LIST_DESTINATIONS_PROPERTIES = {
  includeProviders: {
    type: 'boolean',
    description: 'Also return the enabled providers with their models and reasoning levels for starting a new session. Defaults to false.',
  },
  limit: {
    type: 'integer',
    description: `Maximum number of sessions to return, from 1 to ${LIST_LIMIT_MAX}. Defaults to ${LIST_LIMIT_DEFAULT}.`,
  },
} as const satisfies Record<string, SessionToolProperty>;

const SEND_MESSAGE_PROPERTIES = {
  sessionId: {
    type: 'string',
    description: `Recipient sessionId from ${TOOL_CLAUDIAN_LIST_DESTINATIONS}, or the session_id of a received message. Omit to create a new session.`,
  },
  text: {
    type: 'string',
    description: 'Message for the recipient. Include everything it needs; it cannot see this conversation. Required, except that mode "interrupt" without text only stops the recipient.',
  },
  mode: {
    type: 'string',
    description: [
      '"queue" (default): delivered when the recipient finishes its current work.',
      '"steer": added to the recipient\'s running turn; it is queued instead when there is no running turn to join.',
      '"interrupt": stops the recipient\'s current work like the user\'s Stop, then delivers the message first.',
      '"steer" and "interrupt" need sessionId.',
    ].join(' '),
  },
  provider: {
    type: 'string',
    description: `Provider for a new session; requires model. Only valid when sessionId is omitted; omit both to use the user's new-tab provider and model. ${LIST_OPTIONS_HINT}`,
  },
  model: {
    type: 'string',
    description: [
      'Model id. For a new session, sets its initial model, from provider when given, otherwise from the user\'s new-tab provider (omit to use the new-tab model).',
      'With sessionId, switches that session\'s selection, which persists for its later turns; must belong to that session\'s provider.',
      LIST_OPTIONS_HINT,
    ].join(' '),
  },
  reasoning: {
    type: 'string',
    description: [
      'Reasoning level, only for models with reasoning levels. For a new session, sets its initial level (defaults to the model\'s default level).',
      'With sessionId, switches that session\'s selection, which persists for its later turns; applies to the model it will use.',
      LIST_OPTIONS_HINT,
    ].join(' '),
  },
} as const satisfies Record<string, SessionToolProperty>;

const READ_SESSION_PROPERTIES = {
  sessionId: {
    type: 'string',
    description: `Session to read: a sessionId from ${TOOL_CLAUDIAN_LIST_DESTINATIONS}, the id of a <context_session>, or the session_id of a received message.`,
  },
  beforeTurn: {
    type: 'integer',
    description: 'Return only turns before this turn number, to page back from an earlier result\'s fromTurn. Omit for the latest turns.',
  },
} as const satisfies Record<string, SessionToolProperty>;

export const SESSION_TOOL_SPECS: readonly SessionToolSpec[] = [
  {
    name: TOOL_CLAUDIAN_LIST_DESTINATIONS,
    description: [
      `List where ${TOOL_CLAUDIAN_SEND_MESSAGE} can deliver: existing Claudian chat sessions and, on request, options for a new session.`,
      'Returns {sessions, truncated?, providers?}.',
      'sessions is a list of {sessionId, title, provider, status, active, self?}, most recently active first and capped by limit; truncated is true when more exist.',
      'status is "idle", "running", or "awaiting-user"; active marks the session the user is viewing; self: true marks the calling session, which cannot be messaged.',
      'With includeProviders: true, providers lists the enabled providers as {provider, default?, models: [{id, default?, reasoning?: {options, default}}]};',
      'default marks what a new session uses when provider, model, or reasoning is omitted, and reasoning appears only for models with reasoning levels.',
    ].join(' '),
    inputSchema: { type: 'object', properties: LIST_DESTINATIONS_PROPERTIES, additionalProperties: false },
  },
  {
    name: TOOL_CLAUDIAN_SEND_MESSAGE,
    description: [
      'Send a message to another Claudian chat session, or omit sessionId to start a new one.',
      'The message starts a turn in the recipient, or queues until it is free.',
      'Returns {sessionId, title, provider, status} immediately, naming the recipient; it does not wait for the turn or a reply.',
      'status is "started" or "queued" for a delivered message, "steered" when it joined the running turn, "uncertain" when a steer may or may not have arrived (do not resend),',
      '"interrupted" when running work was stopped (the message, if any, is next), or "idle" when an interrupt without text found nothing running.',
      'A session cannot message itself.',
      'Messages from other sessions arrive wrapped in <session_message from="…" session_id="…">.',
      `Replying is optional: call ${TOOL_CLAUDIAN_SEND_MESSAGE} with that session_id only if a response is needed.`,
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: SEND_MESSAGE_PROPERTIES,
      additionalProperties: false,
    },
  },
  {
    name: TOOL_CLAUDIAN_READ_SESSION,
    description: [
      'Read another Claudian chat session: each turn\'s user prompt and final reply, without tool calls or thinking.',
      'Use it for a session the user mentions as <context_session id="…">, or to check on a session you messaged.',
      'Returns {sessionId, title, provider, status, content, fromTurn, toTurn, totalTurns}; content is Markdown with turns numbered from 1.',
      'It holds the latest completed turns that fit; a turn still running is left out.',
      'When fromTurn is greater than 1, pass it as beforeTurn to read earlier turns.',
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: READ_SESSION_PROPERTIES,
      required: ['sessionId'],
      additionalProperties: false,
    },
  },
];

export function decodeSessionToolCall(name: string, args: unknown): SessionToolCallDecodeResult {
  if (name !== TOOL_CLAUDIAN_LIST_DESTINATIONS && name !== TOOL_CLAUDIAN_SEND_MESSAGE && name !== TOOL_CLAUDIAN_READ_SESSION) {
    return { ok: false, error: `Unknown session tool "${name}".` };
  }
  const input = args ?? {};
  if (typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, error: 'Tool arguments must be an object.' };
  }
  const record = input as Record<string, unknown>;
  const properties = name === TOOL_CLAUDIAN_SEND_MESSAGE ? SEND_MESSAGE_PROPERTIES
    : name === TOOL_CLAUDIAN_READ_SESSION ? READ_SESSION_PROPERTIES : LIST_DESTINATIONS_PROPERTIES;
  const unexpected = Object.keys(record).find(key => !Object.hasOwn(properties, key));
  if (unexpected !== undefined) {
    return { ok: false, error: `Unexpected argument "${unexpected}".` };
  }
  // Null is accepted as omitted: some native harnesses send null for absent optionals.
  if (name === TOOL_CLAUDIAN_LIST_DESTINATIONS) {
    const includeProviders = record.includeProviders ?? false;
    if (typeof includeProviders !== 'boolean') {
      return { ok: false, error: '"includeProviders" must be a boolean.' };
    }
    const limit = record.limit ?? LIST_LIMIT_DEFAULT;
    if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > LIST_LIMIT_MAX) {
      return { ok: false, error: `"limit" must be an integer from 1 to ${LIST_LIMIT_MAX}.` };
    }
    return { ok: true, call: { tool: name, args: { includeProviders, limit } } };
  }
  if (name === TOOL_CLAUDIAN_READ_SESSION) {
    const { sessionId } = record;
    if (typeof sessionId !== 'string' || sessionId.trim() === '') {
      return { ok: false, error: '"sessionId" must be a non-empty string.' };
    }
    const beforeTurn = record.beforeTurn ?? undefined;
    if (beforeTurn !== undefined && (typeof beforeTurn !== 'number' || !Number.isInteger(beforeTurn) || beforeTurn < 1)) {
      return { ok: false, error: '"beforeTurn" must be a positive integer.' };
    }
    return { ok: true, call: { tool: name, args: { sessionId, ...(beforeTurn !== undefined ? { beforeTurn } : {}) } } };
  }

  const mode = record.mode ?? 'queue';
  if (mode !== 'queue' && mode !== 'steer' && mode !== 'interrupt') {
    return { ok: false, error: '"mode" must be "queue", "steer" or "interrupt".' };
  }
  const sendArgs: { -readonly [K in keyof SessionToolSendMessageArgs]: SessionToolSendMessageArgs[K] } = {};
  for (const key of ['sessionId', 'text', 'provider', 'model', 'reasoning'] as const) {
    const value = record[key];
    if ((value === undefined || value === null) && (key !== 'text' || mode === 'interrupt')) continue;
    if (typeof value !== 'string' || value.trim() === '') {
      return { ok: false, error: `"${key}" must be a non-empty string.` };
    }
    sendArgs[key] = value;
  }
  if (mode !== 'queue') {
    if (sendArgs.sessionId === undefined) return { ok: false, error: '"steer" and "interrupt" need "sessionId".' };
    sendArgs.mode = mode;
  }
  const switches = sendArgs.model !== undefined || sendArgs.reasoning !== undefined;
  if (mode === 'steer' && switches) {
    return { ok: false, error: '"model" and "reasoning" cannot be used with "steer"; the running turn keeps its own.' };
  }
  if (sendArgs.text === undefined && switches) {
    return { ok: false, error: '"model" and "reasoning" need "text".' };
  }
  if (sendArgs.sessionId !== undefined && sendArgs.provider !== undefined) {
    return { ok: false, error: '"provider" applies only when "sessionId" is omitted.' };
  }
  if (sendArgs.provider !== undefined && sendArgs.model === undefined) {
    return { ok: false, error: '"provider" requires "model".' };
  }
  return { ok: true, call: { tool: name, args: sendArgs } };
}
