import { randomBytes } from 'node:crypto';
import { type IncomingMessage, request } from 'node:http';
import { StringDecoder } from 'node:string_decoder';

import { ManagedStdioProcess } from '@/core/process/ManagedStdioProcess';
import { toAbortError } from '@/utils/abort';

export interface OpencodeHTTPEvent {
  readonly type: string;
  readonly data: Record<string, unknown>;
}

export class OpencodeHTTPError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

/** One authenticated loopback server, owned through the native stdin lease. */
export class OpencodeHTTPClient {
  private readonly controller = new AbortController();
  private readonly password = randomBytes(32).toString('base64url');
  private readonly process: ManagedStdioProcess;
  private endpoint: Promise<string> | null = null;

  constructor(cliPath: string, private readonly cwd: string, environment: NodeJS.ProcessEnv) {
    this.process = new ManagedStdioProcess({
      command: cliPath, args: ['serve', '--stdio', '--hostname', '127.0.0.1', '--port', '0'],
      cwd, env: { ...environment, OPENCODE_PASSWORD: this.password },
    });
  }

  signal(signal?: AbortSignal): AbortSignal {
    return signal ? AbortSignal.any([signal, this.controller.signal]) : this.controller.signal;
  }

  isReusable(): boolean {
    return !this.controller.signal.aborted && this.process.getExitState() === null;
  }

  async request<T = unknown>(route: string, options: {
    method?: 'GET' | 'POST' | 'PATCH' | 'DELETE'; body?: unknown; signal?: AbortSignal; timeoutMs?: number;
  } = {}): Promise<T> {
    const response = await this.open(route, options);
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const value of response) {
      const chunk = value as Buffer;
      size += chunk.length;
      if (size > 32 * 1024 * 1024) {
        response.destroy();
        throw new Error('OpenCode HTTP response exceeded the size limit.');
      }
      chunks.push(chunk);
    }
    const text = Buffer.concat(chunks).toString('utf8');
    if (response.statusCode! < 200 || response.statusCode! >= 300) {
      throw new OpencodeHTTPError(response.statusCode!, `OpenCode HTTP request failed (${response.statusCode}): ${text.slice(0, 1000)}`);
    }
    return (text ? JSON.parse(text) : undefined) as T;
  }

  /** Resolves once subscribed; any later disconnect is explicit, never silently loses output. */
  async subscribe(onEvent: (event: OpencodeHTTPEvent) => void, onError: (error: Error) => void): Promise<void> {
    const response = await this.open('/api/event', { streaming: true });
    if (response.statusCode !== 200) {
      response.destroy();
      throw new Error('Could not subscribe to OpenCode events.');
    }
    let connected = false;
    const ready = new Promise<void>((resolve, reject) => {
      const decoder = new StringDecoder('utf8');
      let buffer = '';
      const fail = (error: Error): void => {
        if (!connected) reject(error);
        if (!this.controller.signal.aborted) onError(error);
      };
      response.on('data', (chunk: Buffer) => {
        try {
          buffer = (buffer + decoder.write(chunk)).replace(/\r\n/g, '\n');
          if (buffer.length > 32 * 1024 * 1024) throw new Error('OpenCode event exceeded the size limit.');
          let end: number;
          while ((end = buffer.indexOf('\n\n')) >= 0) {
            const frame = buffer.slice(0, end);
            buffer = buffer.slice(end + 2);
            const data = frame.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
            if (!data) continue;
            const event: unknown = JSON.parse(data);
            if (!isRecord(event) || typeof event.type !== 'string' || !isRecord(event.data)) continue;
            if (event.type === 'server.connected') { connected = true; window.clearTimeout(timer); resolve(); }
            onEvent(event as unknown as OpencodeHTTPEvent);
          }
        } catch (error) { response.destroy(error instanceof Error ? error : new Error(String(error))); }
      });
      response.on('error', fail);
      response.on('end', () => fail(new Error('OpenCode event stream closed. Reopen the conversation to reload native history.')));
      const timer = window.setTimeout(() => {
        if (!connected) response.destroy(new Error('OpenCode event subscription timed out.'));
      }, 10_000);
      response.on('close', () => window.clearTimeout(timer));
      // A connected stream has no request deadline; native heartbeats keep the lease observable.
    });
    await ready;
  }

  async dispose(): Promise<void> {
    this.controller.abort();
    await this.process.shutdown();
  }

  private async open(route: string, options: {
    method?: string; body?: unknown; signal?: AbortSignal; timeoutMs?: number; streaming?: boolean;
  }): Promise<IncomingMessage> {
    const signal = this.signal(options.signal);
    signal.throwIfAborted();
    this.endpoint ??= this.start().catch(async error => {
      this.controller.abort(error);
      await this.dispose();
      throw error;
    });
    // Cancelling a reader must not cancel the server startup shared by other readers.
    const endpoint = await new Promise<string>((resolve, reject) => {
      const onAbort = (): void => reject(toAbortError(signal, 'OpenCode HTTP request aborted.'));
      signal.addEventListener('abort', onAbort, { once: true });
      this.endpoint!.then(
        endpoint => { signal.removeEventListener('abort', onAbort); resolve(endpoint); },
        error => { signal.removeEventListener('abort', onAbort); reject(error instanceof Error ? error : new Error(String(error))); },
      );
      if (signal.aborted) {
        signal.removeEventListener('abort', onAbort);
        onAbort();
      }
    });
    signal.throwIfAborted();
    const url = new URL(route, endpoint);
    // Callers provide paths, never credentials or arbitrary endpoints.
    if (url.origin !== endpoint) throw new Error('Invalid OpenCode API route.');
    url.searchParams.set('location[directory]', this.cwd);
    return new Promise((resolve, reject) => {
      const req = request(url, {
        method: options.method ?? 'GET', signal,
        headers: {
          Authorization: `Basic ${Buffer.from(`opencode:${this.password}`).toString('base64')}`,
          ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
      }, response => {
        if (options.streaming) window.clearTimeout(timer);
        resolve(response);
      });
      req.on('error', reject);
      const timer = options.timeoutMs === 0 ? undefined : window.setTimeout(() => req.destroy(new Error('OpenCode HTTP request timed out.')), options.timeoutMs ?? 30_000);
      req.on('close', () => window.clearTimeout(timer));
      req.end(options.body === undefined ? undefined : JSON.stringify(options.body));
    });
  }

  private start(): Promise<string> {
    const signal = this.controller.signal;
    return new Promise((resolve, reject) => {
      let output = '';
      let settled = false;
      const finish = (error?: Error, url?: string): void => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timeout);
        signal.removeEventListener('abort', onAbort);
        if (error) reject(error); else resolve(url!);
      };
      const onAbort = (): void => finish(new Error('OpenCode server startup aborted.'));
      const timeout = window.setTimeout(() => finish(new Error('OpenCode server startup timed out.')), 10_000);
      signal.addEventListener('abort', onAbort, { once: true });
      this.process.onError(() => finish(new Error('Could not start the OpenCode server.')));
      this.process.onClose(() => finish(new Error('OpenCode server closed before readiness.')));
      try {
        signal.throwIfAborted();
        this.process.start();
        this.process.stdout.on('data', (chunk: Buffer) => {
          if (settled) return;
          output += chunk.toString('utf8');
          if (output.length > 16_384) { finish(new Error('Invalid OpenCode catalog server readiness response.')); return; }
          const end = output.indexOf('\n');
          if (end < 0) return;
          try {
            const ready: unknown = JSON.parse(output.slice(0, end));
            if (!isRecord(ready) || typeof ready.url !== 'string') throw new Error();
            const url = new URL(ready.url);
            if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password) throw new Error();
            finish(undefined, url.origin);
          } catch { finish(new Error('Invalid OpenCode catalog server readiness response.')); }
        });
      } catch { finish(new Error('Could not start the OpenCode server.')); }
    });
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Re-reads native state that initializes asynchronously; returns the last value after the deadline. */
export async function pollOpencodeUntil<T>(read: () => Promise<T>, done: (value: T) => boolean, timeoutMs: number, signal: AbortSignal): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (done(value) || Date.now() >= deadline) return value;
    await new Promise<void>((resolve, reject) => {
      signal.throwIfAborted();
      const onAbort = (): void => { window.clearTimeout(timer); reject(toAbortError(signal, 'OpenCode request aborted.')); };
      const timer = window.setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(); }, 25);
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }
}
