import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import {
  SESSION_TOOL_ROUTE_HEADER,
  type SessionToolEndpoint,
  type SessionToolRoute,
  type SessionToolRoutedCallHandler,
} from './SessionToolEndpoint';
import { createSessionToolMCPDispatcher } from './sessionToolMCP';
import type { SessionToolCallHandler, SessionToolResult } from './sessionToolSpecs';

export interface LoopbackSessionToolServerOptions {
  readonly maxBodyBytes?: number;
  /** Bounds receiving a request; a call may run longer once its body has arrived. */
  readonly requestTimeoutMs?: number;
  readonly headersTimeoutMs?: number;
}

const LOOPBACK_HOST = '127.0.0.1';
const MCP_PATH = '/mcp';
const CALL_PATH = '/call';
const ROUTE_HEADER = SESSION_TOOL_ROUTE_HEADER.toLowerCase();
const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_HEADERS_TIMEOUT_MS = 10_000;
const ROUTE_ID_BYTES = 32;
const CLOSED_MESSAGE = 'The session tool endpoint is closed.';

interface RouteOutcome {
  readonly status: number;
  readonly body?: unknown;
}

interface RouteRecord {
  readonly path: string;
  readonly inFlight: Set<AbortController>;
  serve(body: string, signal: AbortSignal): Promise<RouteOutcome>;
}

class BodyTooLargeError extends Error {}

/**
 * Loopback HTTP endpoint for session tools. It listens on 127.0.0.1 only after
 * the first route registration and defends against browser requests: any
 * `Origin` is rejected, `Host` must name this loopback port, and bodies must
 * be JSON. Route ids are unguessable bearer secrets carried in a header.
 */
export class LoopbackSessionToolServer implements SessionToolEndpoint {
  readonly #maxBodyBytes: number;
  readonly #requestTimeoutMs: number;
  readonly #headersTimeoutMs: number;
  readonly #routes = new Map<string, RouteRecord>();
  #server: Server | null = null;
  #listening: Promise<number> | null = null;
  #allowedHosts: ReadonlySet<string> = new Set();
  #closed = false;

  constructor(options: LoopbackSessionToolServerOptions = {}) {
    this.#maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
    this.#requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.#headersTimeoutMs = options.headersTimeoutMs ?? DEFAULT_HEADERS_TIMEOUT_MS;
  }

  registerMCPRoute(handler: SessionToolCallHandler): Promise<SessionToolRoute> {
    const dispatcher = createSessionToolMCPDispatcher(handler);
    return this.#register(MCP_PATH, async (body, signal) => {
      let message: unknown;
      try {
        message = JSON.parse(body);
      } catch {
        return { status: 400, body: { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } } };
      }
      const response = await dispatcher.handle(message, signal);
      return response ? { status: 200, body: response } : { status: 202 };
    });
  }

  registerCallRoute(handler: SessionToolRoutedCallHandler): Promise<SessionToolRoute> {
    return this.#register(CALL_PATH, async (body, signal) => {
      let request: unknown;
      try {
        request = JSON.parse(body);
      } catch {
        return { status: 400, body: { error: 'Invalid JSON.' } };
      }
      if (
        typeof request !== 'object' || request === null
        || typeof (request as Record<string, unknown>).tool !== 'string'
        || typeof (request as Record<string, unknown>).callerNativeId !== 'string'
        || (request as Record<string, unknown>).callerNativeId === ''
      ) {
        return { status: 400, body: { error: 'Expected {tool, args, callerNativeId}.' } };
      }
      const { tool, args, callerNativeId } = request as { tool: string; args?: unknown; callerNativeId: string };
      let result: SessionToolResult;
      try {
        result = await handler({ name: tool, args, callerNativeId, signal });
      } catch (error) {
        result = { isError: true, text: error instanceof Error ? error.message : String(error) };
      }
      return { status: 200, body: { isError: result.isError, text: result.text } };
    });
  }

  /** Revokes every route, aborts in-flight calls, and stops listening. Later registrations reject. */
  async close(): Promise<void> {
    this.#closed = true;
    for (const route of this.#routes.values()) abortAll(route.inFlight);
    this.#routes.clear();
    await this.#listening?.catch(() => undefined);
    const server = this.#server;
    this.#server = null;
    if (!server) return;
    await new Promise<void>(resolve => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  }

  async #register(path: string, serve: RouteRecord['serve']): Promise<SessionToolRoute> {
    const port = await this.#listen();
    if (this.#closed) throw new Error(CLOSED_MESSAGE);
    const routeId = randomBytes(ROUTE_ID_BYTES).toString('base64url');
    const record: RouteRecord = { path, inFlight: new Set(), serve };
    this.#routes.set(routeId, record);
    return {
      url: `http://${LOOPBACK_HOST}:${port}${path}`,
      routeId,
      headers: { [SESSION_TOOL_ROUTE_HEADER]: routeId },
      dispose: () => {
        if (this.#routes.get(routeId) !== record) return;
        this.#routes.delete(routeId);
        abortAll(record.inFlight);
      },
    };
  }

  #listen(): Promise<number> {
    if (this.#closed) return Promise.reject(new Error(CLOSED_MESSAGE));
    this.#listening ??= new Promise<number>((resolve, reject) => {
      const server = createServer({
        requestTimeout: this.#requestTimeoutMs,
        headersTimeout: this.#headersTimeoutMs,
        connectionsCheckingInterval: Math.min(this.#headersTimeoutMs, DEFAULT_HEADERS_TIMEOUT_MS),
      }, (req, res) => void this.#handle(req, res));
      this.#server = server;
      server.once('error', reject);
      server.listen(0, LOOPBACK_HOST, () => {
        server.off('error', reject);
        // Post-listen server errors must not crash the host; affected requests fail on their own.
        server.on('error', () => undefined);
        const { port } = server.address() as AddressInfo;
        this.#allowedHosts = new Set([`${LOOPBACK_HOST}:${port}`, `localhost:${port}`]);
        resolve(port);
      });
    }).catch((error: unknown) => {
      this.#listening = null;
      this.#server = null;
      throw error;
    });
    return this.#listening;
  }

  async #handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.#allowedHosts.has(req.headers.host?.toLowerCase() ?? '')) {
      return sendJSON(res, 403, { error: 'Forbidden host.' });
    }
    if (req.headers.origin !== undefined) {
      return sendJSON(res, 403, { error: 'Browser requests are not allowed.' });
    }
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST');
      return sendJSON(res, 405, { error: 'Method not allowed.' });
    }
    const routeId = req.headers[ROUTE_HEADER];
    const route = typeof routeId === 'string' ? this.#routes.get(routeId) : undefined;
    if (!route || req.url?.split('?')[0] !== route.path) {
      return sendJSON(res, 404, { error: 'Unknown route.' });
    }
    if (req.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') {
      return sendJSON(res, 415, { error: 'Expected application/json.' });
    }
    if (Number(req.headers['content-length']) > this.#maxBodyBytes) {
      return sendTooLarge(res);
    }

    const controller = new AbortController();
    route.inFlight.add(controller);
    // Bridge disconnects into a Claudian-owned controller; no signal is passed into Node APIs.
    res.on('close', () => {
      route.inFlight.delete(controller);
      if (!res.writableEnded) controller.abort();
    });

    let outcome: RouteOutcome;
    try {
      const body = await readBody(req, this.#maxBodyBytes);
      outcome = await route.serve(body, controller.signal);
    } catch (error) {
      if (error instanceof BodyTooLargeError) return sendTooLarge(res);
      // The request was aborted or timed out while its body was arriving.
      if (!res.headersSent) res.destroy();
      return;
    }
    if (res.destroyed || res.writableEnded) return;
    if (controller.signal.aborted) return sendJSON(res, 410, { error: 'Route revoked.' });
    sendJSON(res, outcome.status, outcome.body);
  }
}

function readBody(req: IncomingMessage, maxBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        req.removeAllListeners('data');
        reject(new BodyTooLargeError());
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
    req.on('close', () => {
      if (!req.complete) reject(new Error('Request aborted.'));
    });
  });
}

function sendTooLarge(res: ServerResponse): void {
  res.setHeader('Connection', 'close');
  sendJSON(res, 413, { error: 'Request body too large.' });
}

function sendJSON(res: ServerResponse, status: number, body?: unknown): void {
  if (body === undefined) {
    res.writeHead(status);
    res.end();
    return;
  }
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) });
  res.end(payload);
}

function abortAll(controllers: Set<AbortController>): void {
  for (const controller of controllers) controller.abort();
  controllers.clear();
}
