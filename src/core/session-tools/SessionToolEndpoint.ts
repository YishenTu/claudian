import type {
  SessionToolCallHandler,
  SessionToolCallRequest,
  SessionToolResult,
} from './sessionToolSpecs';

/** Carries the route id, because some native clients persist server URLs but not headers. */
export const SESSION_TOOL_ROUTE_HEADER = 'X-Claudian-Route';

export interface SessionToolRoute {
  /** Generic endpoint URL; it carries no route identity. */
  readonly url: string;
  /** Unguessable bearer-equivalent route id, also present in `headers`. */
  readonly routeId: string;
  /** Headers every request to this route must carry. */
  readonly headers: Readonly<Record<string, string>>;
  /** Revokes the route and aborts its in-flight calls. Idempotent. */
  dispose(): void;
}

export interface SessionToolRoutedCallRequest extends SessionToolCallRequest {
  /** Native caller identity forwarded by a provider plugin; the handler resolves it to a session port. */
  readonly callerNativeId: string;
}

export type SessionToolRoutedCallHandler = (request: SessionToolRoutedCallRequest) => Promise<SessionToolResult>;

/**
 * Loopback endpoint through which provider processes reach session tools. It
 * serves Claudian's own provider processes only.
 */
export interface SessionToolEndpoint {
  /** MCP Streamable HTTP route (JSON responses only) bound to one native session. */
  registerMCPRoute(handler: SessionToolCallHandler): Promise<SessionToolRoute>;
  /**
   * JSON call route for shared provider processes: POST `{tool, args, callerNativeId}`
   * answers `{isError, text}`.
   */
  registerCallRoute(handler: SessionToolRoutedCallHandler): Promise<SessionToolRoute>;
}
