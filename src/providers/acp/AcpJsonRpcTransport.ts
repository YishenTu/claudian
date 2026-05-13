import { createInterface, type Interface } from 'node:readline';

import type { AcpRequestId } from './types';

const DEFAULT_TIMEOUT_MS = 30_000;

interface JsonRpcRequestMessage {
  id: AcpRequestId;
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
}

interface JsonRpcNotificationMessage {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
}

interface JsonRpcResponseMessage {
  error?: {
    code: number;
    data?: unknown;
    message: string;
  };
  id: AcpRequestId;
  jsonrpc: '2.0';
  result?: unknown;
}

type JsonRpcMessage =
  | JsonRpcRequestMessage
  | JsonRpcNotificationMessage
  | JsonRpcResponseMessage;

export interface JsonRpcMessageStreams {
  input: NodeJS.ReadableStream;
  onClose?: (listener: (error?: Error) => void) => () => void;
  output: NodeJS.WritableStream;
}

export interface JsonRpcRequestOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

type JsonRpcNotificationHandler = (params: unknown) => void | Promise<void>;
type JsonRpcRequestHandler = (params: unknown) => Promise<unknown>;

interface PendingRequest {
  cleanup: () => void;
  method: string;
  reject: (error: Error) => void;
  resolve: (result: unknown) => void;
}

export class JsonRpcTransportClosedError extends Error {
  constructor(message = 'JSON-RPC transport closed') {
    super(message);
    this.name = 'JsonRpcTransportClosedError';
  }
}

export class JsonRpcErrorResponse extends Error {
  constructor(
    readonly method: string,
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = 'JsonRpcErrorResponse';
  }
}

export class AcpJsonRpcTransport {
  private readonly abortController = new AbortController();
  private readonly closeListeners = new Set<(error?: Error) => void>();
  private disposed = false;
  private nextId = 1;
  private readonly notificationHandlers = new Map<string, Set<JsonRpcNotificationHandler>>();
  private readonly pending = new Map<number, PendingRequest>();
  private readline: Interface | null = null;
  private readonly requestHandlers = new Map<string, JsonRpcRequestHandler>();
  private unregisterClose?: () => void;

  constructor(
    private readonly streams: JsonRpcMessageStreams,
    private readonly defaultTimeoutMs = DEFAULT_TIMEOUT_MS,
  ) {}

  get signal(): AbortSignal {
    return this.abortController.signal;
  }

  get isClosed(): boolean {
    return this.disposed;
  }

  start(): void {
    if (this.readline || this.disposed) {
      return;
    }

    this.readline = createInterface({
      crlfDelay: Infinity,
      input: this.streams.input,
    });
    this.readline.on('line', line => this.handleLine(line));
    this.readline.on('close', () => {
      if (!this.disposed) {
        this.dispose(new JsonRpcTransportClosedError('JSON-RPC input closed'));
      }
    });

    this.unregisterClose = this.streams.onClose?.((error) => {
      if (!this.disposed) {
        this.dispose(error ?? new JsonRpcTransportClosedError());
      }
    });
  }

  onClose(listener: (error?: Error) => void): () => void {
    this.closeListeners.add(listener);
    return () => {
      this.closeListeners.delete(listener);
    };
  }

  onNotification(method: string, handler: JsonRpcNotificationHandler): () => void {
    let handlers = this.notificationHandlers.get(method);
    if (!handlers) {
      handlers = new Set();
      this.notificationHandlers.set(method, handlers);
    }
    handlers.add(handler);

    return () => {
      const current = this.notificationHandlers.get(method);
      if (!current) return;
      current.delete(handler);
      if (current.size === 0) {
        this.notificationHandlers.delete(method);
      }
    };
  }

  onRequest(method: string, handler: JsonRpcRequestHandler): () => void {
    this.requestHandlers.set(method, handler);
    return () => {
      if (this.requestHandlers.get(method) === handler) {
        this.requestHandlers.delete(method);
      }
    };
  }

  async request<T = unknown>(
    method: string,
    params?: unknown,
    options: JsonRpcRequestOptions = {},
  ): Promise<T> {
    this.start();

    if (this.disposed) {
      throw new JsonRpcTransportClosedError();
    }

    const id = this.nextId++;
    const timeoutMs = options.timeoutMs ?? this.defaultTimeoutMs;

    return new Promise<T>((resolve, reject) => {
      let timer: number | undefined;
      let onAbort: (() => void) | undefined;

      const cleanup = (): void => {
        if (timer) window.clearTimeout(timer);
        if (onAbort && options.signal) {
          options.signal.removeEventListener('abort', onAbort);
        }
      };
      const resolvePending = (result: unknown): void => {
        resolve(result as T);
      };

      const pending: PendingRequest = {
        cleanup,
        method,
        reject,
        resolve: resolvePending,
      };

      if (timeoutMs > 0) {
        timer = window.setTimeout(() => {
          this.pending.delete(id);
          cleanup();
          reject(new Error(`Request timeout: ${method} (${timeoutMs}ms)`));
        }, timeoutMs);
      }

      if (options.signal) {
        if (options.signal.aborted) {
          cleanup();
          reject(new Error(`Request aborted: ${method}`));
          return;
        }
        onAbort = () => {
          this.pending.delete(id);
          cleanup();
          reject(new Error(`Request aborted: ${method}`));
        };
        options.signal.addEventListener('abort', onAbort, { once: true });
      }

      this.pending.set(id, pending);

      try {
        this.sendRaw({ id, jsonrpc: '2.0', method, params });
      } catch (error) {
        this.pending.delete(id);
        cleanup();
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  notify(method: string, params?: unknown): void {
    this.start();
    if (this.disposed) {
      return;
    }
    this.sendRaw({ jsonrpc: '2.0', method, params });
  }

  dispose(error: Error = new JsonRpcTransportClosedError('JSON-RPC transport disposed')): void {
    if (this.disposed) {
      return;
    }

    this.disposed = true;
    this.abortController.abort();

    this.unregisterClose?.();
    this.unregisterClose = undefined;

    if (this.readline) {
      this.readline.removeAllListeners();
      this.readline.close();
      this.readline = null;
    }

    for (const [id, pending] of this.pending) {
      pending.cleanup();
      pending.reject(error);
      this.pending.delete(id);
    }

    for (const listener of this.closeListeners) {
      try {
        listener(error);
      } catch {
        // Best-effort listener dispatch.
      }
    }
  }

  private handleLine(line: string): void {
    if (line.trim().length === 0) {
      return;
    }

    let message: JsonRpcMessage;
    try {
      message = JSON.parse(line) as JsonRpcMessage;
    } catch {
      return;
    }

    if ('id' in message && !('method' in message)) {
      this.handleResponse(message);
      return;
    }
    if ('method' in message && 'id' in message) {
      this.handleRequest(message);
      return;
    }
    if ('method' in message) {
      this.handleNotification(message);
    }
  }

  private handleResponse(message: JsonRpcResponseMessage): void {
    if (typeof message.id !== 'number') {
      return;
    }

    const pending = this.pending.get(message.id);
    if (!pending) {
      return;
    }

    this.pending.delete(message.id);
    pending.cleanup();

    if (message.error) {
      pending.reject(new JsonRpcErrorResponse(
        pending.method,
        message.error.code,
        message.error.message,
        message.error.data,
      ));
      return;
    }

    pending.resolve(message.result);
  }

  private handleNotification(message: JsonRpcNotificationMessage): void {
    const handlers = this.notificationHandlers.get(message.method);
    if (!handlers || handlers.size === 0) {
      return;
    }

    for (const handler of handlers) {
      void Promise.resolve(handler(message.params)).catch(() => {
        // Notification failures are non-fatal to the transport.
      });
    }
  }

  private handleRequest(message: JsonRpcRequestMessage): void {
    const handler = this.requestHandlers.get(message.method);
    if (!handler) {
      this.sendRaw({
        error: {
          code: -32601,
          message: `Unhandled server request: ${message.method}`,
        },
        id: message.id,
        jsonrpc: '2.0',
      });
      return;
    }

    void Promise.resolve(handler(message.params)).then(
      (result) => {
        this.sendRaw({ id: message.id, jsonrpc: '2.0', result });
      },
      (error) => {
        this.sendRaw({
          error: {
            code: -32603,
            message: error instanceof Error ? error.message : 'Internal error',
          },
          id: message.id,
          jsonrpc: '2.0',
        });
      },
    );
  }

  private sendRaw(message: JsonRpcMessage): void {
    if (this.disposed) {
      throw new JsonRpcTransportClosedError();
    }
    this.streams.output.write(`${JSON.stringify(message)}\n`);
  }
}
