import type { Readable, Writable } from 'node:stream';

import { subscribePiJsonlLines, writePiJsonl } from './PiJsonl';

const DEFAULT_TIMEOUT_MS = 30_000;

export type PiRpcRecord = Record<string, unknown>;
export type PiRpcEventHandler = (event: PiRpcRecord) => void;

export interface PiRpcStreams {
  input: Readable | NodeJS.ReadableStream;
  onClose?: (listener: (error?: Error) => void) => () => void;
  output: Writable | NodeJS.WritableStream;
}

interface PendingRequest {
  cleanup: () => void;
  reject: (error: Error) => void;
  resolve: (response: unknown) => void;
  type: string;
}

export class PiRpcTransportClosedError extends Error {
  constructor(message = 'Pi RPC transport closed') {
    super(message);
    this.name = 'PiRpcTransportClosedError';
  }
}

export class PiRpcResponseError extends Error {
  constructor(
    readonly commandType: string,
    message: string,
  ) {
    super(message);
    this.name = 'PiRpcResponseError';
  }
}

export class PiRpcTransport {
  private readonly closeListeners = new Set<(error?: Error) => void>();
  private disposed = false;
  private readonly eventHandlers = new Set<PiRpcEventHandler>();
  private nextId = 1;
  private readonly pending = new Map<string, PendingRequest>();
  private unregisterClose?: () => void;
  private unsubscribeLines?: () => void;

  constructor(
    private readonly streams: PiRpcStreams,
    private readonly defaultTimeoutMs = DEFAULT_TIMEOUT_MS,
  ) {}

  get isClosed(): boolean {
    return this.disposed;
  }

  start(): void {
    if (this.unsubscribeLines || this.disposed) {
      return;
    }

    this.unsubscribeLines = subscribePiJsonlLines(
      this.streams.input,
      (line) => this.handleLine(line),
      () => {
        if (!this.disposed) {
          this.dispose(new PiRpcTransportClosedError('Pi RPC input closed'));
        }
      },
      (error) => {
        if (!this.disposed) {
          this.dispose(error);
        }
      },
    );

    this.unregisterClose = this.streams.onClose?.((error) => {
      if (!this.disposed) {
        this.dispose(error ?? new PiRpcTransportClosedError());
      }
    });
  }

  onEvent(handler: PiRpcEventHandler): () => void {
    this.eventHandlers.add(handler);
    return () => {
      this.eventHandlers.delete(handler);
    };
  }

  onClose(listener: (error?: Error) => void): () => void {
    this.closeListeners.add(listener);
    return () => {
      this.closeListeners.delete(listener);
    };
  }

  request<T = unknown>(
    commandType: string,
    payload: Record<string, unknown> = {},
    timeoutMs = this.defaultTimeoutMs,
  ): Promise<T> {
    this.start();
    if (this.disposed) {
      return Promise.reject(new PiRpcTransportClosedError());
    }

    const id = `req_${this.nextId++}`;
    return new Promise<T>((resolve, reject) => {
      let timer: number | undefined;
      const cleanup = (): void => {
        if (timer !== undefined) {
          window.clearTimeout(timer);
        }
      };

      if (timeoutMs > 0) {
        timer = window.setTimeout(() => {
          this.pending.delete(id);
          cleanup();
          reject(new Error(`Request timeout: ${commandType} (${timeoutMs}ms)`));
        }, timeoutMs);
      }

      this.pending.set(id, {
        cleanup,
        reject,
        resolve: (response: unknown) => resolve(response as T),
        type: commandType,
      });

      try {
        this.sendRaw({ id, type: commandType, ...payload });
      } catch (error) {
        this.pending.delete(id);
        cleanup();
        const transportError = error instanceof Error ? error : new Error(String(error));
        this.dispose(transportError);
        reject(transportError);
      }
    });
  }

  send(record: PiRpcRecord): void {
    this.start();
    if (this.disposed) {
      return;
    }
    this.sendRaw(record);
  }

  dispose(error: Error = new PiRpcTransportClosedError('Pi RPC transport disposed')): void {
    if (this.disposed) {
      return;
    }

    this.disposed = true;
    this.unsubscribeLines?.();
    this.unsubscribeLines = undefined;
    this.unregisterClose?.();
    this.unregisterClose = undefined;
    this.rejectAllPending(error);
    for (const listener of this.closeListeners) {
      try {
        listener(error);
      } catch {
        // Best-effort close notification.
      }
    }
    this.closeListeners.clear();
    this.eventHandlers.clear();
  }

  private sendRaw(record: PiRpcRecord): void {
    writePiJsonl(this.streams.output, record);
  }

  private handleLine(line: string): void {
    if (!line.trim()) {
      return;
    }

    let record: PiRpcRecord;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (!isPlainObject(parsed)) {
        return;
      }
      record = parsed;
    } catch {
      return;
    }

    if (record.type === 'response' && typeof record.id === 'string') {
      this.handleResponse(record.id, record);
      return;
    }

    for (const handler of this.eventHandlers) {
      handler(record);
    }
  }

  private handleResponse(id: string, record: PiRpcRecord): void {
    const pending = this.pending.get(id);
    if (!pending) {
      return;
    }

    this.pending.delete(id);
    pending.cleanup();
    if (record.success === false) {
      const errorText = typeof record.error === 'string'
        ? record.error
        : `Pi RPC command failed: ${pending.type}`;
      pending.reject(new PiRpcResponseError(pending.type, errorText));
      return;
    }

    if ('result' in record) {
      pending.resolve(record.result);
      return;
    }
    if ('data' in record) {
      pending.resolve(record.data);
      return;
    }
    pending.resolve(record);
  }

  private rejectAllPending(error: Error): void {
    for (const pending of this.pending.values()) {
      pending.cleanup();
      pending.reject(error);
    }
    this.pending.clear();
  }
}

function isPlainObject(value: unknown): value is PiRpcRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
