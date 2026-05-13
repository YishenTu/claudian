import { createInterface } from 'readline';

import type { CodexAppServerProcess } from './CodexAppServerProcess';
import type { JsonRpcError } from './codexAppServerTypes';

const DEFAULT_TIMEOUT_MS = 30_000;

interface PendingRequest {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timer: number | null;
}

type NotificationHandler = (params: unknown) => void;
type ServerRequestHandler = (requestId: string | number, params: unknown) => Promise<unknown>;

export class CodexRpcTransport {
  private nextId = 1;
  private pending = new Map<number, PendingRequest>();
  private notificationHandlers = new Map<string, NotificationHandler>();
  private serverRequestHandlers = new Map<string, ServerRequestHandler>();
  private disposed = false;

  constructor(private readonly proc: CodexAppServerProcess) {}

  start(): void {
    const rl = createInterface({ input: this.proc.stdout });
    rl.on('line', (line) => this.handleLine(line));

    this.proc.onExit(() => {
      this.rejectAllPending(new Error('App-server process exited'));
    });
  }

  request<T = unknown>(method: string, params: unknown, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<T> {
    const id = this.nextId++;
    const msg = { jsonrpc: '2.0' as const, id, method, params };

    return new Promise<T>((resolve, reject) => {
      const timer = timeoutMs > 0
        ? window.setTimeout(() => {
          this.pending.delete(id);
          reject(new Error(`Request timeout: ${method} (${timeoutMs}ms)`));
        }, timeoutMs)
        : null;

      const resolvePending = (result: unknown): void => {
        resolve(result as T);
      };

      this.pending.set(id, {
        resolve: resolvePending,
        reject,
        timer,
      });

      this.sendRaw(msg);
    });
  }

  notify(method: string, params?: unknown): void {
    const msg: Record<string, unknown> = { jsonrpc: '2.0', method };
    if (params !== undefined) msg.params = params;
    this.sendRaw(msg);
  }

  onNotification(method: string, handler: NotificationHandler): void {
    this.notificationHandlers.set(method, handler);
  }

  onServerRequest(method: string, handler: ServerRequestHandler): void {
    this.serverRequestHandlers.set(method, handler);
  }

  dispose(): void {
    this.disposed = true;
    this.rejectAllPending(new Error('Transport disposed'));
  }

  // -----------------------------------------------------------------------
  // Private
  // -----------------------------------------------------------------------

  private sendRaw(msg: unknown): void {
    if (this.disposed) return;
    this.proc.stdin.write(JSON.stringify(msg) + '\n');
  }

  private handleLine(line: string): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return; // malformed line
    }

    const id = msg.id as string | number | undefined;
    const method = msg.method as string | undefined;

    // Server response to our request
    if (typeof id === 'number' && !method) {
      this.handleResponse(id, msg);
      return;
    }

    // Server notification (no id, has method)
    if (method && id === undefined) {
      this.handleNotification(method, msg.params);
      return;
    }

    // Server-initiated request (has both id and method)
    if (method && id !== undefined) {
      this.handleServerRequest(id, method, msg.params);
      return;
    }
  }

  private handleResponse(id: number, msg: Record<string, unknown>): void {
    const pending = this.pending.get(id);
    if (!pending) return;

    this.pending.delete(id);
    if (pending.timer) window.clearTimeout(pending.timer);

    if (msg.error) {
      const err = msg.error as JsonRpcError;
      pending.reject(new Error(err.message));
    } else {
      pending.resolve(msg.result);
    }
  }

  private handleNotification(method: string, params: unknown): void {
    const handler = this.notificationHandlers.get(method);
    if (handler) handler(params);
  }

  private handleServerRequest(id: string | number, method: string, params: unknown): void {
    const handler = this.serverRequestHandlers.get(method);
    if (!handler) {
      this.sendRaw({
        jsonrpc: '2.0',
        id,
        error: { code: -32601, message: `Unhandled server request: ${method}` },
      });
      return;
    }

    handler(id, params).then(
      (result) => {
        this.sendRaw({ jsonrpc: '2.0', id, result });
      },
      (err) => {
        this.sendRaw({
          jsonrpc: '2.0',
          id,
          error: { code: -32603, message: err instanceof Error ? err.message : 'Internal error' },
        });
      },
    );
  }

  private rejectAllPending(error: Error): void {
    for (const [, pending] of this.pending) {
      if (pending.timer) window.clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}
