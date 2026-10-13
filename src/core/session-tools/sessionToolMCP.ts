/**
 * Minimal MCP server for the session tools, shared by in-process transports and
 * the loopback HTTP endpoint. Hand-written so neither the MCP SDK nor zod enters
 * the bundle.
 */

import { isSessionTool } from '@/core/tools/toolNames';

import {
  SESSION_TOOL_SPECS,
  type SessionToolCallHandler,
  type SessionToolResult,
} from './sessionToolSpecs';

export const SESSION_TOOL_MCP_SERVER_NAME = 'claudian_sessions';

const SUPPORTED_PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05', '2024-10-07'];
const SERVER_VERSION = '1.0.0';
const TOOL_USE_ID_META_KEY = 'claudecode/toolUseId';
/** Loads the tools up front instead of deferring them behind native tool search. */
const ALWAYS_LOAD_META = { 'anthropic/alwaysLoad': true } as const;

const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;

type JSONRPCId = string | number;

export type SessionToolMCPResponse =
  | { readonly jsonrpc: '2.0'; readonly id: JSONRPCId; readonly result: unknown }
  | { readonly jsonrpc: '2.0'; readonly id: JSONRPCId | null; readonly error: { readonly code: number; readonly message: string } };

export interface SessionToolMCPDispatcher {
  /**
   * Handles one JSON-RPC message. Resolves to the response to send, or
   * undefined for notifications, client responses, and aborted calls.
   * `signal` aborts a tool call started by this message, e.g. on disconnect.
   */
  handle(message: unknown, signal?: AbortSignal): Promise<SessionToolMCPResponse | undefined>;
  abortAll(): void;
}

/**
 * The transport shape shared by the MCP SDK `Transport` and the Claude SDK's
 * in-process transport. Method syntax keeps native message-typed callbacks assignable.
 */
export interface SessionToolMCPTransport {
  onmessage?(message: unknown): void;
  onclose?(): void;
  start(): Promise<void>;
  send(message: unknown): Promise<void>;
}

export interface SessionToolMCPServer {
  connect(transport: SessionToolMCPTransport): Promise<void>;
}

const TOOLS = SESSION_TOOL_SPECS.map(spec => ({
  name: spec.name,
  description: spec.description,
  inputSchema: spec.inputSchema,
  _meta: ALWAYS_LOAD_META,
}));

export function createSessionToolMCPDispatcher(handler: SessionToolCallHandler): SessionToolMCPDispatcher {
  const inFlight = new Map<JSONRPCId, AbortController>();

  async function callTool(
    id: JSONRPCId,
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
  ): Promise<SessionToolMCPResponse | undefined> {
    const name = params.name;
    if (typeof name !== 'string' || !isSessionTool(name)) {
      return errorResponse(id, INVALID_PARAMS, `Unknown tool: ${String(name)}`);
    }
    if (inFlight.has(id)) return errorResponse(id, INVALID_REQUEST, `Duplicate request id: ${String(id)}`);

    const controller = new AbortController();
    const abort = () => controller.abort();
    inFlight.set(id, controller);
    if (signal?.aborted) controller.abort();
    else signal?.addEventListener('abort', abort, { once: true });
    const meta = isRecord(params._meta) ? params._meta : undefined;
    const toolUseId = meta?.[TOOL_USE_ID_META_KEY];

    try {
      let result: SessionToolResult;
      try {
        result = await handler({
          name,
          args: params.arguments,
          signal: controller.signal,
          ...(typeof toolUseId === 'string' ? { nativeToolUseId: toolUseId } : {}),
        });
      } catch (error) {
        result = { isError: true, text: error instanceof Error ? error.message : String(error) };
      }
      // A cancelled request gets no response.
      if (controller.signal.aborted) return undefined;
      return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: result.text }], isError: result.isError } };
    } finally {
      signal?.removeEventListener('abort', abort);
      if (inFlight.get(id) === controller) inFlight.delete(id);
    }
  }

  return {
    async handle(message, signal) {
      if (!isRecord(message) || message.jsonrpc !== '2.0') {
        return errorResponse(null, INVALID_REQUEST, 'Invalid JSON-RPC message');
      }
      const { id, method } = message;
      if (typeof method !== 'string') {
        // Responses to server requests; this server sends none.
        if ('result' in message || 'error' in message) return undefined;
        return errorResponse(null, INVALID_REQUEST, 'Invalid JSON-RPC message');
      }
      const params = isRecord(message.params) ? message.params : {};
      if (id === undefined) {
        if (method === 'notifications/cancelled') {
          const requestId = params.requestId;
          if (typeof requestId === 'string' || typeof requestId === 'number') inFlight.get(requestId)?.abort();
        }
        return undefined;
      }
      if (typeof id !== 'string' && typeof id !== 'number') {
        return errorResponse(null, INVALID_REQUEST, 'Invalid JSON-RPC request id');
      }

      switch (method) {
        case 'initialize': {
          const requested = params.protocolVersion;
          const protocolVersion = typeof requested === 'string' && SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
            ? requested
            : SUPPORTED_PROTOCOL_VERSIONS[0];
          return {
            jsonrpc: '2.0',
            id,
            result: {
              protocolVersion,
              capabilities: { tools: { listChanged: false } },
              serverInfo: { name: SESSION_TOOL_MCP_SERVER_NAME, version: SERVER_VERSION },
            },
          };
        }
        case 'ping':
          return { jsonrpc: '2.0', id, result: {} };
        case 'tools/list':
          return { jsonrpc: '2.0', id, result: { tools: TOOLS } };
        case 'tools/call':
          return callTool(id, params, signal);
        default:
          return errorResponse(id, METHOD_NOT_FOUND, `Method not found: ${method}`);
      }
    },
    abortAll() {
      for (const controller of inFlight.values()) controller.abort();
    },
  };
}

/** An in-process MCP server object; each connection gets its own dispatcher. */
export function createSessionToolMCPServer(handler: SessionToolCallHandler): SessionToolMCPServer {
  return {
    async connect(transport) {
      const dispatcher = createSessionToolMCPDispatcher(handler);
      transport.onmessage = message => {
        void dispatcher.handle(message)
          .then(response => response && transport.send(response))
          // The transport closed before the response could be sent; nobody awaits it.
          .catch(() => undefined);
      };
      transport.onclose = () => dispatcher.abortAll();
      await transport.start();
    },
  };
}

function errorResponse(id: JSONRPCId | null, code: number, message: string): SessionToolMCPResponse {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
