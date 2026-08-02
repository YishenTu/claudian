import { createInterface, type Interface } from 'node:readline';

const DEFAULT_TIMEOUT_MS = 30_000;

export type JsonRpcRequestId = number | string | null;

interface JsonRpcRequestMessage {
  id: JsonRpcRequestId;
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
  id: JsonRpcRequestId;
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

export interface JsonRpcTransportOptions {
  streamCloseGraceMs?: number;
}

export interface JsonRpcRequestHandlerContext {
  method: string;
  requestId: JsonRpcRequestId;
}

export type JsonRpcNotificationHandler = (params: unknown) => void | Promise<void>;
export type JsonRpcRequestHandler = (
  params: unknown,
  context: JsonRpcRequestHandlerContext,
) => unknown | Promise<unknown>;

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

export class JsonRpcTransport {
  private readonly abortController = new AbortController();
  private readonly closeListeners = new Set<(error?: Error) => void>();
  private disposed = false;
  private nextId = 1;
  private readonly notificationHandlers = new Map<string, Set<JsonRpcNotificationHandler>>();
  private readonly pending = new Map<number, PendingRequest>();
  private readline: Interface | null = null;
  private readonly requestHandlers = new Map<string, JsonRpcRequestHandler>();
  private streamCloseTimer: number | null = null;
  private readonly streamUnsubscribers: Array<() => void> = [];
  private unregisterClose?: () => void;

  constructor(
    private readonly streams: JsonRpcMessageStreams,
    private readonly defaultTimeoutMs = DEFAULT_TIMEOUT_MS,
    private readonly options: JsonRpcTransportOptions = {},
  ) {}

  get signal(): AbortSignal {
    return this.abortController.signal;
  }

  get isClosed(): boolean {
    return this.disposed;
  }

  start(): void {
    if (this.readline || this.disposed) return;

    this.readline = createInterface({
      crlfDelay: Infinity,
      input: this.streams.input,
    });
    this.readline.on('line', line => this.handleLine(line));
    this.readline.on('error', (error: Error) => {
      this.closeFromUnknown(error, 'JSON-RPC input error');
    });
    this.readline.on('close', () => {
      this.closeFromStream('JSON-RPC input closed');
    });

    this.streamUnsubscribers.push(
      subscribeStreamEvent(this.streams.input, 'error', (error?: unknown) => {
        this.closeFromUnknown(error, 'JSON-RPC input error');
      }),
      subscribeStreamEvent(this.streams.input, 'end', () => {
        this.closeFromStream('JSON-RPC input closed');
      }),
      subscribeStreamEvent(this.streams.input, 'close', () => {
        this.closeFromStream('JSON-RPC input closed');
      }),
      subscribeStreamEvent(this.streams.output, 'error', (error?: unknown) => {
        this.closeFromUnknown(error, 'JSON-RPC output error');
      }),
      subscribeStreamEvent(this.streams.output, 'close', () => {
        this.closeFromStream('JSON-RPC output closed');
      }),
    );

    this.unregisterClose = this.streams.onClose?.((error) => {
      if (!this.disposed) {
        this.dispose(error ?? new JsonRpcTransportClosedError());
      }
    });
  }

  onClose(listener: (error?: Error) => void): () => void {
    if (this.disposed) return () => {};
    this.closeListeners.add(listener);
    return () => {
      this.closeListeners.delete(listener);
    };
  }

  onNotification(method: string, handler: JsonRpcNotificationHandler): () => void {
    if (this.disposed) return () => {};
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
      if (current.size === 0) this.notificationHandlers.delete(method);
    };
  }

  onRequest(method: string, handler: JsonRpcRequestHandler): () => void {
    if (this.disposed) return () => {};
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
    if (this.disposed) throw new JsonRpcTransportClosedError();

    const id = this.nextId++;
    const timeoutMs = options.timeoutMs ?? this.defaultTimeoutMs;

    return new Promise<T>((resolve, reject) => {
      let timer: number | undefined;
      let onAbort: (() => void) | undefined;

      const cleanup = (): void => {
        if (timer !== undefined) window.clearTimeout(timer);
        if (onAbort && options.signal) {
          options.signal.removeEventListener('abort', onAbort);
        }
      };

      if (timeoutMs > 0) {
        timer = window.setTimeout(() => {
          this.pending.delete(id);
          cleanup();
          reject(new Error(`Request timeout: ${method} (${timeoutMs}ms)`));
        }, timeoutMs);
      }

      if (options.signal?.aborted) {
        cleanup();
        reject(new Error(`Request aborted: ${method}`));
        return;
      }
      if (options.signal) {
        onAbort = () => {
          this.pending.delete(id);
          cleanup();
          reject(new Error(`Request aborted: ${method}`));
        };
        options.signal.addEventListener('abort', onAbort, { once: true });
      }

      this.pending.set(id, {
        cleanup,
        method,
        reject,
        resolve: result => resolve(result as T),
      });

      try {
        this.sendRaw({ id, jsonrpc: '2.0', method, params });
      } catch (error) {
        this.pending.delete(id);
        cleanup();
        const transportError = toError(error);
        this.dispose(transportError);
        reject(transportError);
      }
    });
  }

  notify(method: string, params?: unknown): void {
    this.start();
    if (this.disposed) return;
    this.trySendRaw({ jsonrpc: '2.0', method, params });
  }

  flush(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    return new Promise((resolve, reject) => {
      try {
        this.streams.output.write('', (error?: Error | null) => {
          if (error) reject(error);
          else resolve();
        });
      } catch (error) {
        reject(toError(error));
      }
    });
  }

  dispose(error: Error = new JsonRpcTransportClosedError('JSON-RPC transport disposed')): void {
    if (this.disposed) return;
    this.disposed = true;
    this.abortController.abort();

    if (this.streamCloseTimer !== null) {
      window.clearTimeout(this.streamCloseTimer);
      this.streamCloseTimer = null;
    }

    this.unregisterClose?.();
    this.unregisterClose = undefined;
    while (this.streamUnsubscribers.length > 0) {
      this.streamUnsubscribers.pop()?.();
    }

    if (this.readline) {
      const readline = this.readline;
      this.readline = null;
      readline.close();
      readline.removeAllListeners();
    }

    for (const pending of this.pending.values()) {
      pending.cleanup();
      pending.reject(error);
    }
    this.pending.clear();

    for (const listener of [...this.closeListeners]) {
      try {
        listener(error);
      } catch {
        // Close observers cannot interrupt transport cleanup.
      }
    }
    this.closeListeners.clear();
    this.notificationHandlers.clear();
    this.requestHandlers.clear();
  }

  private closeFromUnknown(error: unknown, fallbackMessage: string): void {
    if (this.disposed) return;
    this.dispose(error instanceof Error
      ? error
      : new JsonRpcTransportClosedError(fallbackMessage));
  }

  private closeFromStream(message: string): void {
    if (this.disposed || this.streamCloseTimer !== null) return;

    const graceMs = this.options.streamCloseGraceMs ?? 0;
    const error = new JsonRpcTransportClosedError(message);
    if (!this.streams.onClose || graceMs <= 0) {
      this.dispose(error);
      return;
    }

    this.streamCloseTimer = window.setTimeout(() => {
      this.streamCloseTimer = null;
      this.dispose(error);
    }, graceMs);
  }

  private handleLine(line: string): void {
    if (!line.trim()) return;

    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch {
      return;
    }
    if (!isRecord(parsed)) return;
    const message = parsed as unknown as JsonRpcMessage;

    if ('id' in message && !('method' in message)) {
      this.handleResponse(message);
      return;
    }
    if ('method' in message && 'id' in message) {
      this.handleRequest(message);
      return;
    }
    if ('method' in message) this.handleNotification(message);
  }

  private handleResponse(message: JsonRpcResponseMessage): void {
    if (typeof message.id !== 'number') return;
    const pending = this.pending.get(message.id);
    if (!pending) return;

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
    if (!handlers) return;
    for (const handler of [...handlers]) {
      void Promise.resolve().then(() => handler(message.params)).catch(() => {
        // Notification failures are non-fatal to the transport.
      });
    }
  }

  private handleRequest(message: JsonRpcRequestMessage): void {
    const handler = this.requestHandlers.get(message.method);
    if (!handler) {
      this.trySendRaw({
        error: {
          code: -32601,
          message: `Unhandled server request: ${message.method}`,
        },
        id: message.id,
        jsonrpc: '2.0',
      });
      return;
    }

    const context: JsonRpcRequestHandlerContext = {
      method: message.method,
      requestId: message.id,
    };
    void Promise.resolve().then(() => handler(message.params, context)).then(
      result => this.trySendRaw({ id: message.id, jsonrpc: '2.0', result }),
      error => this.trySendRaw({
        error: {
          code: -32603,
          message: error instanceof Error ? error.message : 'Internal error',
        },
        id: message.id,
        jsonrpc: '2.0',
      }),
    );
  }

  private sendRaw(message: JsonRpcMessage): void {
    if (this.disposed) throw new JsonRpcTransportClosedError();
    this.streams.output.write(`${JSON.stringify(message)}\n`);
  }

  private trySendRaw(message: JsonRpcMessage): void {
    try {
      this.sendRaw(message);
    } catch (error) {
      this.dispose(toError(error));
    }
  }
}

type StreamWithEvents = {
  off?: (eventName: string, listener: (...args: unknown[]) => void) => void;
  on?: (eventName: string, listener: (...args: unknown[]) => void) => void;
  removeListener?: (eventName: string, listener: (...args: unknown[]) => void) => void;
};

function subscribeStreamEvent(
  stream: NodeJS.ReadableStream | NodeJS.WritableStream,
  eventName: string,
  listener: (...args: unknown[]) => void,
): () => void {
  const evented = stream as StreamWithEvents;
  evented.on?.(eventName, listener);
  return () => {
    if (typeof evented.off === 'function') {
      evented.off(eventName, listener);
      return;
    }
    evented.removeListener?.(eventName, listener);
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
