import {
  JsonRpcErrorResponse,
  type JsonRpcRequestId,
  JsonRpcTransport,
} from '@/core/rpc/JsonRpcTransport';

import type { CodexAppServerProcess } from './CodexAppServerProcess';
import type { JsonRpcError } from './codexAppServerTypes';

const DEFAULT_TIMEOUT_MS = 30_000;
const PROCESS_CLOSE_GRACE_MS = 3_000;

type NotificationHandler = (params: unknown) => void;
type ServerRequestHandler = (requestId: string | number, params: unknown) => Promise<unknown>;

export class CodexRpcResponseError extends Error {
  readonly code: number;
  readonly data: unknown;

  constructor(error: JsonRpcError) {
    super(error.message);
    this.name = 'CodexRpcResponseError';
    this.code = error.code;
    this.data = error.data;
  }
}

export class CodexRpcTransport {
  private disposed = false;
  private readonly notificationHandlers = new Map<string, NotificationHandler>();
  private readonly notificationUnsubscribers = new Map<string, () => void>();
  private readonly serverRequestHandlers = new Map<string, ServerRequestHandler>();
  private readonly serverRequestUnsubscribers = new Map<string, () => void>();
  private transport: JsonRpcTransport | null = null;

  constructor(private readonly proc: CodexAppServerProcess) {}

  start(): void {
    if (this.transport || this.disposed) return;

    const transport = new JsonRpcTransport({
      input: this.proc.stdout,
      onClose: (listener) => {
        const exitHandler = (): void => {
          listener(new Error(this.buildProcessExitMessage()));
        };
        this.proc.onExit(exitHandler);
        return () => this.proc.offExit(exitHandler);
      },
      output: this.proc.stdin,
    }, DEFAULT_TIMEOUT_MS, { streamCloseGraceMs: PROCESS_CLOSE_GRACE_MS });
    this.transport = transport;

    for (const [method, handler] of this.notificationHandlers) {
      this.registerNotificationHandler(transport, method, handler);
    }
    for (const [method, handler] of this.serverRequestHandlers) {
      this.registerServerRequestHandler(transport, method, handler);
    }
    transport.start();
  }

  async request<T = unknown>(
    method: string,
    params: unknown,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  ): Promise<T> {
    if (this.disposed) throw new Error('Transport disposed');
    this.start();

    try {
      return await this.transport!.request<T>(method, params, { timeoutMs });
    } catch (error) {
      if (error instanceof JsonRpcErrorResponse) {
        throw new CodexRpcResponseError({
          code: error.code,
          data: error.data,
          message: error.message,
        });
      }
      throw error;
    }
  }

  notify(method: string, params?: unknown): void {
    if (this.disposed) return;
    this.start();
    this.transport!.notify(method, params);
  }

  onNotification(method: string, handler: NotificationHandler): void {
    this.notificationHandlers.set(method, handler);
    if (this.transport) {
      this.registerNotificationHandler(this.transport, method, handler);
    }
  }

  onServerRequest(method: string, handler: ServerRequestHandler): void {
    this.serverRequestHandlers.set(method, handler);
    if (this.transport) {
      this.registerServerRequestHandler(this.transport, method, handler);
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.clearUnsubscribers(this.notificationUnsubscribers);
    this.clearUnsubscribers(this.serverRequestUnsubscribers);
    this.transport?.dispose(new Error('Transport disposed'));
    this.transport = null;
    this.notificationHandlers.clear();
    this.serverRequestHandlers.clear();
  }

  private registerNotificationHandler(
    transport: JsonRpcTransport,
    method: string,
    handler: NotificationHandler,
  ): void {
    this.notificationUnsubscribers.get(method)?.();
    this.notificationUnsubscribers.set(method, transport.onNotification(method, handler));
  }

  private registerServerRequestHandler(
    transport: JsonRpcTransport,
    method: string,
    handler: ServerRequestHandler,
  ): void {
    this.serverRequestUnsubscribers.get(method)?.();
    this.serverRequestUnsubscribers.set(method, transport.onRequest(
      method,
      (params, context) => handler(context.requestId as Exclude<JsonRpcRequestId, null>, params),
    ));
  }

  private clearUnsubscribers(unsubscribers: Map<string, () => void>): void {
    for (const unsubscribe of unsubscribers.values()) unsubscribe();
    unsubscribers.clear();
  }

  private buildProcessExitMessage(): string {
    const stderr = this.proc.getStderrSnapshot();
    return stderr ? `App-server process exited\n\n${stderr}` : 'App-server process exited';
  }
}
