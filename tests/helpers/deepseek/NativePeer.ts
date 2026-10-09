import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { WebSocket, WebSocketServer } from 'ws';

import { DeepSeekRemoteClient } from '@/providers/deepseek/remote/DeepSeekRemoteClient';
import { DeepSeekHost } from '@/providers/deepseek/runtime/DeepSeekHost';

export interface NativePeerHostOptions {
  readonly idleMs?: number;
  /** Runs before each process start; reject to simulate a failed launch. */
  readonly beforeStart?: (signal: AbortSignal) => Promise<void>;
  /** Runs inside process disposal; hold it to simulate slow teardown. */
  readonly onDispose?: () => Promise<void>;
}

export interface NativePeerLifecycle {
  starts: number;
  disposed: number;
  readonly prompts: Array<{ preset: string; text: string }>;
  /** Simulates the native process exiting on its own. */
  exit(): void;
}

/** Native wire peer. All adapter decoding and lifecycle logic runs in production code. */
export class NativePeer {
  readonly calls: Array<{ method: string; args: Record<string, any> }> = [];
  readonly streams = new Map<string, { socket: WebSocket; endpoint: string; args: Record<string, any> }>();
  onCall: (method: string, args: Record<string, any>) => unknown | Promise<unknown> = () => ({});
  onOpen: (endpoint: string, args: Record<string, any>, send: (value: unknown) => void) => void = () => {};
  private readonly server = createServer((request, response) => {
    if (request.url === '/?token=fixture') {
      response.writeHead(302, { 'Set-Cookie': 'session=fixture', Location: '/' }).end(); return;
    }
    if (request.headers.cookie !== 'session=fixture') { response.writeHead(401).end(); return; }
    let body = '';
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      const frame = JSON.parse(body);
      const args = frame.payload.args;
      this.calls.push({ method: frame.method, args });
      void Promise.resolve().then(() => this.onCall(frame.method, args)).then(
        value => response.end(JSON.stringify({ rpcId: frame.rpcId, result: { ok: true, value } })),
        error => response.end(JSON.stringify({ rpcId: frame.rpcId, result: { ok: false, error: { message: String(error), ...(error && typeof error.code === 'string' ? { code: error.code } : {}) } } })),
      );
    });
  });
  private readonly sockets = new WebSocketServer({ server: this.server, path: '/api/remote.mux' });
  client!: DeepSeekRemoteClient;

  async open(): Promise<void> {
    this.sockets.on('connection', socket => socket.on('message', bytes => {
      const frame = JSON.parse(bytes.toString());
      if (frame.type === 'cancel') { this.streams.delete(frame.streamId); return; }
      if (frame.type !== 'open') { socket.close(1008, 'invalid Remote stream request'); return; }
      this.streams.set(frame.streamId, { socket, endpoint: frame.endpoint, args: frame.payload.args });
      const send = (value: unknown): void => { socket.send(JSON.stringify({ type: 'item', streamId: frame.streamId, value })); };
      if (frame.endpoint === '$events') send({ type: 'ready', clientId: 'fixture-client' });
      else this.onOpen(frame.endpoint, frame.payload.args, send);
    }));
    await new Promise<void>(resolve => this.server.listen(0, '127.0.0.1', resolve));
    this.client = await this.connect();
  }

  connect(): Promise<DeepSeekRemoteClient> {
    return DeepSeekRemoteClient.open(`http://127.0.0.1:${(this.server.address() as AddressInfo).port}/?token=fixture`);
  }

  /** A production shared Host whose process is this peer, recording only process lifecycle and prompt files. */
  host(options: NativePeerHostOptions = {}): { deepseek: DeepSeekHost; lifecycle: NativePeerLifecycle } {
    const exits = new Set<() => void>();
    const lifecycle: NativePeerLifecycle = { starts: 0, disposed: 0, prompts: [], exit: () => { for (const listener of [...exits]) listener(); } };
    const deepseek = new DeepSeekHost(async () => ({ cliPath: '/bin/dsh', cwd: '/vault', environment: process.env }), async (_options, signal) => {
      lifecycle.starts++;
      await options.beforeStart?.(signal);
      const client = await this.connect();
      return {
        client,
        onExit: listener => { exits.add(listener); return () => exits.delete(listener); },
        writePrompt: async (preset, text) => { lifecycle.prompts.push({ preset, text }); },
        dispose: async () => { exits.clear(); client.dispose(); lifecycle.disposed++; await options.onDispose?.(); },
      };
    }, options.idleMs);
    return { deepseek, lifecycle };
  }

  send(endpoint: string, value: unknown, matches: (args: Record<string, any>) => boolean = () => true): void {
    for (const [streamId, stream] of this.streams) {
      if (stream.endpoint === endpoint && matches(stream.args) && stream.socket.readyState === WebSocket.OPEN) {
        stream.socket.send(JSON.stringify({ type: 'item', streamId, value }));
      }
    }
  }

  async close(): Promise<void> {
    this.client?.dispose();
    for (const socket of this.sockets.clients) socket.terminate();
    this.sockets.close(); this.server.closeAllConnections();
    await new Promise<void>(resolve => this.server.close(() => resolve()));
  }
}
