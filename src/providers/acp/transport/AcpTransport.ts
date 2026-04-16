// Base transport interface for ACP communication.
// ACP can communicate over stdio (local agents) or HTTP/WebSocket (remote agents).

type NotificationHandler = (params: unknown) => void;
type ServerRequestHandler = (requestId: string | number, params: unknown) => Promise<unknown>;

export interface AcpTransport {
  /**
   * Start the transport connection.
   * For stdio: starts reading from stdout
   * For HTTP/WebSocket: establishes connection
   */
  start(): void | Promise<void>;

  /**
   * Send a request and wait for response.
   */
  request<T = unknown>(method: string, params?: unknown, timeoutMs?: number): Promise<T>;

  /**
   * Send a notification (no response expected).
   */
  notify(method: string, params?: unknown): void | Promise<void>;

  /**
   * Register a handler for server notifications.
   */
  onNotification(method: string, handler: NotificationHandler): void;

  /**
   * Register a handler for server requests (bidi-rpc).
   */
  onServerRequest(method: string, handler: ServerRequestHandler): void;

  /**
   * Check if the transport is alive/connected.
   */
  isAlive(): boolean;

  /**
   * Clean up resources.
   */
  dispose(): void | Promise<void>;
}
