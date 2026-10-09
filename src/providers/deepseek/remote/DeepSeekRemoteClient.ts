import { randomUUID } from 'node:crypto';
import { type IncomingHttpHeaders,request as httpRequest } from 'node:http';

import WebSocket from 'ws';

const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
const RPC_TIMEOUT_MS = 30_000;

type StreamListener = { value: (value: unknown) => void; error: (error: Error) => void };

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Unary native reads; cold readers and live clients both satisfy it. */
export type DeepSeekReader = Pick<DeepSeekRemoteClient, 'call'>;

export class DeepSeekRemoteError extends Error {
  constructor(message: string, readonly code?: string) { super(message); this.name = 'DeepSeekRemoteError'; }
}

/** Authenticated native Typert HTTP and mux transport; never owns an Agent or retries input. */
export class DeepSeekRemoteClient {
  private socket?: WebSocket;
  private readonly lifetime = new AbortController();
  private readonly streams = new Map<string, StreamListener>();
  private readonly disconnectListeners = new Set<(error: Error) => void>();
  private readonly eventListeners = new Set<(event: unknown) => void>();
  private generation = 0;
  private nativeClientId = '';

  private constructor(private readonly origin: string, private readonly cookie: string) {}

  get clientId(): string { return this.nativeClientId; }

  static async open(launchURL: string, signal?: AbortSignal): Promise<DeepSeekRemoteClient> {
    const url = validateLaunchURL(launchURL);
    const response = await requestHTTP(url, 'GET', {}, undefined, signal);
    const cookies = response.headers['set-cookie'];
    if (!cookies?.length || (response.status !== 200 && (response.status < 300 || response.status >= 400))) {
      throw new DeepSeekRemoteError(`DeepSeek launch authentication failed (HTTP ${response.status}).`);
    }
    const client = new DeepSeekRemoteClient(url.origin, cookies.map(cookie => cookie.split(';')[0]).join('; '));
    try {
      await client.connect(signal);
      return client;
    } catch (error) {
      client.dispose();
      throw error;
    }
  }

  async call(method: string, args: Record<string, unknown> = {}, options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<unknown> {
    this.assertLive();
    if (!/^[A-Za-z0-9_$-]+\/[A-Za-z0-9_$-]+$/.test(method)) throw new DeepSeekRemoteError('Invalid DeepSeek RPC endpoint.');
    const rpcId = randomUUID();
    const signal = options.signal ? AbortSignal.any([this.lifetime.signal, options.signal]) : this.lifetime.signal;
    const response = await requestHTTP(new URL(`/api/${method}`, this.origin), 'POST', {
      Cookie: this.cookie, 'Content-Type': 'application/json',
    }, JSON.stringify({ type: 'client-request', rpcId, method, payload: { args } }), signal, options.timeoutMs);
    if (response.status !== 200) throw new DeepSeekRemoteError(`DeepSeek RPC failed (HTTP ${response.status}).`);
    let frame: unknown;
    try { frame = JSON.parse(response.body); } catch { throw new DeepSeekRemoteError('Malformed DeepSeek RPC response.'); }
    if (!isRecord(frame) || !isRecord(frame.result) || typeof frame.result.ok !== 'boolean'
      || (frame.rpcId !== undefined && frame.rpcId !== rpcId)) throw new DeepSeekRemoteError('Malformed DeepSeek RPC result.');
    if (!frame.result.ok) throw this.remoteError(frame.result.error);
    this.assertLive();
    return frame.result.value;
  }

  /** Reconnecting creates a new client generation; owners reacquire all native baselines. The Host serializes reconnects. */
  async connect(signal?: AbortSignal): Promise<void> {
    this.assertLive();
    const generation = ++this.generation;
    this.streams.clear();
    this.nativeClientId = '';
    const socket = new WebSocket(`${this.origin.replace('http:', 'ws:')}/api/remote.mux`, {
      headers: { Cookie: this.cookie }, maxPayload: MAX_RESPONSE_BYTES,
    });
    this.socket = socket;
    const pending = new Promise<void>((resolve, reject) => {
      const abortSignal = signal ? AbortSignal.any([signal, this.lifetime.signal]) : this.lifetime.signal;
      let settled = false;
      const timer = window.setTimeout(() => fail(new DeepSeekRemoteError('DeepSeek event connection timed out.')), RPC_TIMEOUT_MS);
      const abort = (): void => fail(new DeepSeekRemoteError('DeepSeek connection cancelled.'));
      const finish = (error?: Error): void => {
        if (settled) return;
        settled = true; window.clearTimeout(timer); abortSignal.removeEventListener('abort', abort);
        if (error) reject(error); else resolve();
      };
      const fail = (error: Error): void => { finish(error); socket.terminate(); };
      abortSignal.addEventListener('abort', abort, { once: true });
      socket.on('open', () => {
        if (abortSignal.aborted || generation !== this.generation) { abort(); return; }
        this.subscribe('$events', {}, value => {
          if (!isRecord(value)) throw new DeepSeekRemoteError('Malformed DeepSeek event.');
          if (value.type === 'ready') {
            if (typeof value.clientId !== 'string' || !value.clientId) throw new DeepSeekRemoteError('DeepSeek event readiness lacks client identity.');
            this.nativeClientId = value.clientId;
            finish();
          } else for (const listener of this.eventListeners) listener(value);
        }, fail);
      });
      socket.on('message', bytes => {
        if (generation !== this.generation || this.lifetime.signal.aborted) return;
        try {
          const frame: unknown = JSON.parse((Array.isArray(bytes) ? Buffer.concat(bytes) : Buffer.from(bytes as ArrayBuffer)).toString('utf8'));
          if (!isRecord(frame) || typeof frame.streamId !== 'string') throw new DeepSeekRemoteError('Malformed DeepSeek stream frame.');
          const listener = this.streams.get(frame.streamId);
          if (!listener) return;
          if (frame.type === 'item') {
            try { listener.value(frame.value); } catch (error) {
              // A subscriber rejecting its own frame ends only that stream; siblings keep the shared mux.
              this.streams.delete(frame.streamId);
              socket.send(JSON.stringify({ type: 'cancel', streamId: frame.streamId }));
              listener.error(error instanceof Error ? error : new DeepSeekRemoteError('Malformed DeepSeek stream.'));
            }
          } else if (frame.type === 'error' || frame.type === 'end') {
            this.streams.delete(frame.streamId);
            const error = frame.type === 'error' ? this.remoteError(frame.error) : new DeepSeekRemoteError('DeepSeek stream ended.');
            listener.error(error);
          } else throw new DeepSeekRemoteError('Unknown DeepSeek stream frame.');
        } catch (error) { fail(error instanceof Error ? error : new DeepSeekRemoteError('Malformed DeepSeek stream.')); }
      });
      socket.on('error', () => fail(new DeepSeekRemoteError('DeepSeek event transport failed.')));
      socket.on('close', () => {
        const error = new DeepSeekRemoteError('DeepSeek event connection closed.');
        finish(error);
        if (generation !== this.generation || this.lifetime.signal.aborted) return;
        this.nativeClientId = ''; this.streams.clear();
        for (const listener of this.disconnectListeners) listener(error);
      });
      if (abortSignal.aborted) abort();
    });
    await pending;
  }

  subscribe(endpoint: string, args: Record<string, unknown>, value: (value: unknown) => void, error: (error: Error) => void): () => void {
    this.assertLive();
    if (this.socket?.readyState !== WebSocket.OPEN) throw new DeepSeekRemoteError('DeepSeek event connection is unavailable.');
    const streamId = randomUUID();
    this.streams.set(streamId, { value, error });
    this.socket.send(JSON.stringify({ type: 'open', streamId, endpoint, payload: { args } }));
    return () => {
      if (!this.streams.delete(streamId)) return;
      if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify({ type: 'cancel', streamId }));
    };
  }

  onEvent(listener: (event: unknown) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  onDisconnect(listener: (error: Error) => void): () => void {
    this.disconnectListeners.add(listener);
    return () => this.disconnectListeners.delete(listener);
  }

  dispose(): void {
    if (this.lifetime.signal.aborted) return;
    this.lifetime.abort(); ++this.generation;
    this.socket?.terminate(); this.streams.clear(); this.eventListeners.clear(); this.disconnectListeners.clear();
  }

  private assertLive(): void {
    if (this.lifetime.signal.aborted) throw new DeepSeekRemoteError('DeepSeek transport is disposed.');
  }

  private remoteError(value: unknown): DeepSeekRemoteError {
    const error = isRecord(value) ? value : {};
    const message = typeof error.message === 'string' ? error.message.slice(0, 8000) : 'DeepSeek native request failed.';
    return new DeepSeekRemoteError(message.replaceAll(this.cookie, '[redacted]'), typeof error.code === 'string' ? error.code : undefined);
  }
}

function validateLaunchURL(value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new DeepSeekRemoteError('DeepSeek requires an authenticated loopback launch URL.'); }
  if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(url.hostname)
    || !url.port || url.username || url.password || url.pathname !== '/' || !url.searchParams.get('token')) {
    throw new DeepSeekRemoteError('DeepSeek requires an authenticated loopback launch URL.');
  }
  return url;
}

async function requestHTTP(
  url: URL, method: string, headers: Record<string, string>, body?: string, signal?: AbortSignal, timeoutMs = RPC_TIMEOUT_MS,
): Promise<{ status: number; headers: IncomingHttpHeaders; body: string }> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    let bytes = 0;
    const chunks: Buffer[] = [];
    const request = httpRequest(url, { method, headers, signal }, response => {
      response.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > MAX_RESPONSE_BYTES) request.destroy(new DeepSeekRemoteError('DeepSeek response exceeds the size limit.'));
        else chunks.push(chunk);
      });
      response.on('error', () => reject(new DeepSeekRemoteError('DeepSeek response was interrupted.')));
      response.on('end', () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    const timer = window.setTimeout(() => request.destroy(new DeepSeekRemoteError('DeepSeek RPC timed out.')), timeoutMs);
    request.on('error', error => reject(error instanceof DeepSeekRemoteError ? error : new DeepSeekRemoteError('DeepSeek HTTP transport failed.')));
    request.on('close', () => window.clearTimeout(timer));
    request.end(body);
  });
}
