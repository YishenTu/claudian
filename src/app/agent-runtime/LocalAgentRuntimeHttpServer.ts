import {
  createServer as createNodeServer,
  type IncomingMessage,
  type RequestListener,
  type Server,
  type ServerResponse,
} from 'node:http';
import type { Socket } from 'node:net';

import type { AgentRuntimeGateway } from './AgentRuntimeGateway';
import type { AgentRuntimePreparedInvocation } from './AgentRuntimeMethodRegistry';
import type {
  AgentRuntimeRpcErrorResponse,
  AgentRuntimeRpcResponse,
} from './AgentRuntimeRpc';

const LOOPBACK_HOST = '127.0.0.1';
const RPC_PATH = '/v1/rpc';
const MAX_BODY_BYTES = 64 * 1024;
const DEFAULT_HANDLER_SHUTDOWN_TIMEOUT_MS = 2_000;
const DEFAULT_INVOCATION_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RESPONSE_BYTES = 16 * 1024 * 1024;

export interface LocalAgentRuntimeHttpServerEndpoint {
  readonly origin: string;
  readonly rpcUrl: string;
}

export interface LocalAgentRuntimeHttpServerOptions {
  readonly createServer?: (listener: RequestListener) => Server;
  readonly handlerShutdownTimeoutMs?: number;
  readonly invocationTimeoutMs?: number;
  readonly maxResponseBytes?: number;
  readonly portCandidates: readonly number[];
}

type BodyReadResult =
  | { readonly status: 'success'; readonly value: unknown }
  | { readonly status: 'invalid-json' }
  | { readonly status: 'too-large' }
  | { readonly status: 'aborted' };

interface AddressInUseError extends Error {
  readonly code: 'EADDRINUSE';
}

export class LocalAgentRuntimeHttpServer {
  private readonly createServer: (listener: RequestListener) => Server;
  private readonly handlerShutdownTimeoutMs: number;
  private readonly invocationTimeoutMs: number;
  private readonly maxResponseBytes: number;
  private readonly portCandidates: readonly number[];
  private readonly activeRequests = new Set<Promise<void>>();
  private readonly activeWriteInvocations = new Set<Promise<AgentRuntimeRpcResponse>>();
  private readonly lateInvocations = new Set<Promise<AgentRuntimeRpcResponse>>();
  private readonly requestControllers = new Set<AbortController>();
  private readonly sockets = new Set<Socket>();
  private server: Server | null = null;
  private endpoint: LocalAgentRuntimeHttpServerEndpoint | null = null;
  private startPromise: Promise<LocalAgentRuntimeHttpServerEndpoint> | null = null;
  private closePromise: Promise<void> | null = null;

  constructor(
    private readonly gateway: AgentRuntimeGateway,
    options: LocalAgentRuntimeHttpServerOptions,
  ) {
    this.createServer = options.createServer ?? createNodeServer;
    this.handlerShutdownTimeoutMs = normalizeShutdownTimeout(
      options.handlerShutdownTimeoutMs ?? DEFAULT_HANDLER_SHUTDOWN_TIMEOUT_MS,
    );
    this.invocationTimeoutMs = normalizeInvocationTimeout(
      options.invocationTimeoutMs ?? DEFAULT_INVOCATION_TIMEOUT_MS,
    );
    this.maxResponseBytes = normalizeResponseBytes(
      options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
    );
    this.portCandidates = normalizePortCandidates(options.portCandidates);
  }

  start(): Promise<LocalAgentRuntimeHttpServerEndpoint> {
    if (this.endpoint) return Promise.resolve(this.endpoint);
    if (this.startPromise) return this.startPromise;
    if (this.closePromise) return this.closePromise.then(() => this.start());

    const pending = this.open();
    this.startPromise = pending;
    const clearPending = () => {
      if (this.startPromise === pending) this.startPromise = null;
    };
    void pending.then(clearPending, clearPending);
    return pending;
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    const pending = this.performClose();
    this.closePromise = pending;
    const clearPending = () => {
      if (this.closePromise === pending) this.closePromise = null;
    };
    void pending.then(clearPending, clearPending);
    return pending;
  }

  async waitForWriteInvocations(): Promise<void> {
    while (this.activeWriteInvocations.size > 0) {
      await Promise.allSettled([...this.activeWriteInvocations]);
    }
  }

  private async open(): Promise<LocalAgentRuntimeHttpServerEndpoint> {
    let lastBindError: AddressInUseError | null = null;
    for (const port of this.portCandidates) {
      const server = this.createHttpServer();
      this.server = server;
      try {
        await listen(server, port);
        const address = server.address();
        if (!address || typeof address === 'string' || address.address !== LOOPBACK_HOST) {
          throw new Error('Agent Runtime did not bind the required loopback address.');
        }
        const origin = `http://${LOOPBACK_HOST}:${address.port}`;
        const endpoint = { origin, rpcUrl: `${origin}${RPC_PATH}` };
        this.endpoint = endpoint;
        return endpoint;
      } catch (error) {
        if (this.server === server) this.server = null;
        await closeServer(server);
        if (!isAddressInUseError(error)) throw error;
        lastBindError = error;
      }
    }
    throw lastBindError ?? new Error('Agent Runtime has no available port candidate.');
  }

  private createHttpServer(): Server {
    const server = this.createServer((request, response) => {
      const pending = this.handleRequest(request, response);
      this.activeRequests.add(pending);
      const release = () => this.activeRequests.delete(pending);
      void pending.then(release, release);
    });
    server.on('connection', socket => {
      this.sockets.add(socket);
      socket.once('close', () => this.sockets.delete(socket));
    });
    server.on('clientError', (_error, socket) => socket.destroy());
    server.on('error', () => undefined);
    return server;
  }

  private async performClose(): Promise<void> {
    const starting = this.startPromise;
    if (starting) {
      try {
        await starting;
      } catch {
        // A failed start already released its partial listener state.
      }
    }

    const server = this.server;
    this.endpoint = null;
    this.server = null;
    for (const controller of this.requestControllers) controller.abort();
    this.requestControllers.clear();
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    if (server) await closeServer(server);
    await settleWithTimeout(
      [...this.activeRequests, ...this.lateInvocations],
      this.handlerShutdownTimeoutMs,
    );
  }

  private async handleRequest(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    try {
      if (request.url !== RPC_PATH) {
        sendTransportError(response, 404, 'RPC route not found.');
        return;
      }
      if (request.method !== 'POST') {
        response.setHeader('Allow', 'POST');
        sendTransportError(response, 405, 'RPC method must be POST.');
        return;
      }
      if (!isJsonContentType(request.headers['content-type'])) {
        sendTransportError(response, 415, 'Content-Type must be application/json.');
        return;
      }

      const controller = new AbortController();
      this.requestControllers.add(controller);
      const abortIncompleteResponse = () => {
        if (!response.writableEnded) controller.abort();
      };
      request.once('aborted', abortIncompleteResponse);
      response.once('close', abortIncompleteResponse);
      try {
        const body = await readJsonBody(request);
        if (body.status === 'aborted' || controller.signal.aborted) return;
        if (body.status === 'too-large') {
          sendTransportError(response, 413, 'RPC request body is too large.');
          return;
        }
        if (body.status === 'invalid-json') {
          sendTransportError(response, 400, 'Invalid JSON request body.');
          return;
        }

        const prepared = this.gateway.prepare(body.value);
        const rpcResponse = prepared.status === 'response'
          ? prepared.response
          : await this.executeWithDeadline(prepared.invocation, controller);
        if (controller.signal.aborted || response.destroyed) return;
        sendRpcJson(
          response,
          rpcResponse.id === null ? 400 : 200,
          rpcResponse,
          this.maxResponseBytes,
        );
      } finally {
        request.off('aborted', abortIncompleteResponse);
        response.off('close', abortIncompleteResponse);
        this.requestControllers.delete(controller);
      }
    } catch {
      if (!response.destroyed && !response.writableEnded) {
        sendJson(response, 500, {
          error: {
            code: 'internal_error',
            message: 'Internal Agent Runtime error.',
          },
          id: null,
        } satisfies AgentRuntimeRpcErrorResponse);
      }
    }
  }

  private executeWithDeadline(
    invocation: AgentRuntimePreparedInvocation,
    requestController: AbortController,
  ): Promise<AgentRuntimeRpcResponse> {
    const executionController = new AbortController();
    const execution = invocation.execute(executionController.signal);
    if (invocation.access === 'write') this.trackWriteInvocation(execution);
    return new Promise(resolve => {
      let settled = false;
      const releaseRequestAbort = () => {
        requestController.signal.removeEventListener('abort', onRequestAbort);
      };
      const finish = (response: AgentRuntimeRpcResponse) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        releaseRequestAbort();
        resolve(response);
      };
      const onRequestAbort = () => {
        executionController.abort();
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        releaseRequestAbort();
        this.trackLateInvocation(execution);
        resolve(cancelled(invocation.id));
      };
      const timer = window.setTimeout(() => {
        if (settled) return;
        settled = true;
        releaseRequestAbort();
        executionController.abort();
        this.trackLateInvocation(execution);
        resolve(requestTimeout(invocation.id));
      }, this.invocationTimeoutMs);
      requestController.signal.addEventListener('abort', onRequestAbort, { once: true });
      if (requestController.signal.aborted) onRequestAbort();
      void execution.then(finish, () => finish(internalError(invocation.id)));
    });
  }

  private trackLateInvocation(execution: Promise<AgentRuntimeRpcResponse>): void {
    this.lateInvocations.add(execution);
    const release = () => this.lateInvocations.delete(execution);
    void execution.then(release, release);
  }

  private trackWriteInvocation(execution: Promise<AgentRuntimeRpcResponse>): void {
    this.activeWriteInvocations.add(execution);
    const release = () => this.activeWriteInvocations.delete(execution);
    void execution.then(release, release);
  }
}

function listen(server: Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen({ host: LOOPBACK_HOST, port });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise(resolve => {
    if (!server.listening) {
      resolve();
      return;
    }
    server.close(() => resolve());
  });
}

function settleWithTimeout(
  requests: readonly Promise<unknown>[],
  timeoutMs: number,
): Promise<void> {
  if (requests.length === 0) return Promise.resolve();
  return new Promise(resolve => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      resolve();
    };
    const timer = window.setTimeout(finish, timeoutMs);
    void Promise.allSettled(requests).then(finish);
  });
}

function isAddressInUseError(error: unknown): error is AddressInUseError {
  return Boolean(
    error
    && typeof error === 'object'
    && 'code' in error
    && error.code === 'EADDRINUSE'
    && 'message' in error
    && typeof error.message === 'string'
    && 'name' in error
    && typeof error.name === 'string',
  );
}

function normalizePortCandidates(candidates: readonly number[]): readonly number[] {
  const unique = [...new Set(candidates)];
  if (
    unique.length === 0
    || unique.some(port => !Number.isInteger(port) || port < 0 || port > 65_535)
  ) {
    throw new Error('Agent Runtime requires valid port candidates.');
  }
  return unique;
}

function normalizeShutdownTimeout(timeoutMs: number): number {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
    throw new Error('Agent Runtime shutdown timeout must be non-negative.');
  }
  return timeoutMs;
}

function normalizeInvocationTimeout(timeoutMs: number): number {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
    throw new Error('Agent Runtime invocation timeout must be non-negative.');
  }
  return timeoutMs;
}

function normalizeResponseBytes(bytes: number): number {
  if (!Number.isSafeInteger(bytes) || bytes < 1) {
    throw new Error('Agent Runtime response limit must be a positive integer.');
  }
  return bytes;
}

function isJsonContentType(value: string | undefined): boolean {
  if (value === undefined) return false;
  const mediaType = value.split(';', 1)[0]?.trim().toLocaleLowerCase('en-US');
  return mediaType === 'application/json';
}

function readJsonBody(request: IncomingMessage): Promise<BodyReadResult> {
  const declaredLength = parseContentLength(request.headers['content-length']);
  if (declaredLength !== null && declaredLength > MAX_BODY_BYTES) {
    request.resume();
    return Promise.resolve({ status: 'too-large' });
  }

  return new Promise(resolve => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    let settled = false;
    const finish = (result: BodyReadResult) => {
      if (settled) return;
      settled = true;
      request.off('data', onData);
      request.off('end', onEnd);
      request.off('aborted', onAborted);
      request.off('error', onAborted);
      resolve(result);
    };
    const onData = (chunk: Buffer) => {
      bytes += chunk.byteLength;
      if (bytes > MAX_BODY_BYTES) {
        request.resume();
        finish({ status: 'too-large' });
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = () => {
      try {
        const text = Buffer.concat(chunks, bytes).toString('utf8');
        finish({ status: 'success', value: JSON.parse(text) as unknown });
      } catch {
        finish({ status: 'invalid-json' });
      }
    };
    const onAborted = () => finish({ status: 'aborted' });
    request.on('data', onData);
    request.once('end', onEnd);
    request.once('aborted', onAborted);
    request.once('error', onAborted);
  });
}

function parseContentLength(value: string | undefined): number | null {
  if (value === undefined || !/^[0-9]+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function sendTransportError(
  response: ServerResponse,
  status: number,
  message: string,
): void {
  sendJson(response, status, {
    error: { code: 'invalid_request', message },
    id: null,
  } satisfies AgentRuntimeRpcErrorResponse);
}

function sendRpcJson(
  response: ServerResponse,
  status: number,
  body: AgentRuntimeRpcResponse,
  maxResponseBytes: number,
): void {
  let effective = body;
  let serialized = JSON.stringify(effective);
  if (Buffer.byteLength(serialized, 'utf8') > maxResponseBytes && body.id !== null) {
    effective = responseTooLarge(body.id);
    serialized = JSON.stringify(effective);
  }
  sendSerializedJson(response, status, serialized);
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  sendSerializedJson(response, status, JSON.stringify(body));
}

function sendSerializedJson(
  response: ServerResponse,
  status: number,
  body: string,
): void {
  if (response.destroyed || response.writableEnded) return;
  response.statusCode = status;
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.end(body);
}

function requestTimeout(id: string): AgentRuntimeRpcErrorResponse {
  return {
    error: {
      code: 'request_timeout',
      message: 'Agent Runtime request timed out.',
    },
    id,
  };
}

function cancelled(id: string): AgentRuntimeRpcErrorResponse {
  return {
    error: {
      code: 'cancelled',
      data: { status: 'cancelled' },
      message: 'collab.error.cancelled',
    },
    id,
  };
}

function responseTooLarge(id: string): AgentRuntimeRpcErrorResponse {
  return {
    error: {
      code: 'response_too_large',
      message: 'Agent Runtime response is too large.',
    },
    id,
  };
}

function internalError(id: string): AgentRuntimeRpcErrorResponse {
  return {
    error: {
      code: 'internal_error',
      message: 'Internal Agent Runtime error.',
    },
    id,
  };
}
