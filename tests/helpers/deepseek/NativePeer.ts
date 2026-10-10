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
  /** Whether the bundled ephemeral plugin reports ready in each process; defaults to true. */
  readonly ephemeralReady?: boolean;
  /** Fails every fork-token withdrawal, as a full or read-only launch directory would. */
  readonly failWithdrawals?: boolean;
}

export interface NativePeerLifecycle {
  starts: number;
  disposed: number;
  readonly prompts: Array<{ preset: string; text: string }>;
  /** Code-mode preferences written to the Host, with how many prompts native had received at that point. */
  readonly codeModes: Array<{ enabled: boolean; promptsSent: number }>;
  /** Ephemeral fork tokens offered to the Host, with how many forks native had received at offer and at withdrawal. */
  readonly ephemeralForks: Array<{ parent: string; atSeq: number; forksAtOffer: number; forksAtWithdraw?: number }>;
  /** Simulates the native process exiting on its own. */
  exit(): void;
}

/** Selects one session-scoped stream by its open arguments. */
export type NativeStreamTarget = (args: Record<string, any>) => boolean;
/** The follow stream of a root session. */
export const rootFollow = (sessionId: string): NativeStreamTarget => args =>
  args.request?.address?.kind === 'session' && args.request.address.sessionId === sessionId;
/** The follow stream of a subagent child session. */
export const childFollow = (childSessionId: string): NativeStreamTarget => args =>
  args.request?.address?.kind === 'subagent' && args.request.address.childSessionId === childSessionId;
/** The job stream of a session. */
export const jobsOf = (sessionId: string): NativeStreamTarget => args => args.request?.sessionId === sessionId;

/** Process-global streams native broadcasts to every subscribed client. */
export type NativeGlobalEndpoint = '$events' | 'session/control';
const GLOBAL_ENDPOINTS: ReadonlySet<string> = new Set<NativeGlobalEndpoint>(['$events', 'session/control']);

/** Native wire peer. All adapter decoding and lifecycle logic runs in production code. */
export class NativePeer {
  readonly calls: Array<{ method: string; args: Record<string, any> }> = [];
  /** Methods whose HTTP request the client closed before a response, which native treats as cancellation. */
  readonly abandoned: string[] = [];
  readonly streams = new Map<string, { socket: WebSocket; endpoint: string; args: Record<string, any> }>();
  onCall: (method: string, args: Record<string, any>) => unknown | Promise<unknown> = () => ({});
  onOpen: (endpoint: string, args: Record<string, any>, send: (value: unknown) => void, fail?: (error: { code: string; message: string }) => void) => void = () => {};
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
      response.on('close', () => { if (!response.writableEnded) this.abandoned.push(frame.method); });
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
      else this.onOpen(frame.endpoint, frame.payload.args, send, error => socket.send(JSON.stringify({ type: 'error', streamId: frame.streamId, error })));
    }));
    await new Promise<void>(resolve => this.server.listen(0, '127.0.0.1', resolve));
    this.client = await this.connect();
  }

  connect(): Promise<DeepSeekRemoteClient> {
    return DeepSeekRemoteClient.open(this.url);
  }

  /** A production shared Host whose process is this peer, recording only process lifecycle, launch files and fork tokens. */
  host(options: NativePeerHostOptions = {}): { deepseek: DeepSeekHost; lifecycle: NativePeerLifecycle } {
    const exits = new Set<() => void>();
    const lifecycle: NativePeerLifecycle = { starts: 0, disposed: 0, prompts: [], codeModes: [], ephemeralForks: [], exit: () => { for (const listener of [...exits]) listener(); } };
    const deepseek = new DeepSeekHost(async () => ({ cliPath: '/bin/dsh', cwd: '/vault', environment: process.env }), async (_options, signal) => {
      lifecycle.starts++;
      await options.beforeStart?.(signal);
      const client = await this.connect();
      return {
        client,
        onExit: listener => { exits.add(listener); return () => exits.delete(listener); },
        writePrompt: async (preset, text) => { lifecycle.prompts.push({ preset, text }); },
        writeCodeMode: async enabled => { lifecycle.codeModes.push({ enabled, promptsSent: this.calls.filter(call => call.method === 'session/prompt').length }); },
        readEphemeralReady: async () => options.ephemeralReady ?? true,
        offerEphemeralFork: async (parent, atSeq) => {
          const forks = (): number => this.calls.filter(call => call.method === 'session/fork').length;
          const offer: NativePeerLifecycle['ephemeralForks'][number] = { parent, atSeq, forksAtOffer: forks() };
          lifecycle.ephemeralForks.push(offer);
          return async () => {
            if (options.failWithdrawals) throw new Error('token file is read-only');
            offer.forksAtWithdraw = forks();
          };
        },
        dispose: async () => { exits.clear(); client.dispose(); lifecycle.disposed++; await options.onDispose?.(); },
      };
    }, options.idleMs);
    return { deepseek, lifecycle };
  }

  /** Base launch URL a native process would print, with the fixture login token. */
  get url(): string {
    return `http://127.0.0.1:${(this.server.address() as AddressInfo).port}/?token=fixture`;
  }

  /**
   * Broadcasts a process-global frame to every subscriber, or delivers a session-scoped frame to exactly one open
   * stream chosen by `target`. A session-scoped send that matches no stream or several fails, so a frame can never
   * reach a root and its children alike by accident.
   */
  send(endpoint: NativeGlobalEndpoint, value: unknown): void;
  send(endpoint: string, value: unknown, target: NativeStreamTarget): void;
  send(endpoint: string, value: unknown, target?: NativeStreamTarget): void {
    const open = [...this.streams].filter(([, stream]) => stream.endpoint === endpoint && stream.socket.readyState === WebSocket.OPEN);
    const global = GLOBAL_ENDPOINTS.has(endpoint);
    if (!global && !target) throw new Error(`${endpoint} is session-scoped; name its target stream.`);
    const matched = global ? open : open.filter(([, stream]) => target!(stream.args));
    if (!global && matched.length !== 1) throw new Error(`Expected one open ${endpoint} stream for the target, found ${matched.length}.`);
    for (const [streamId, stream] of matched) stream.socket.send(JSON.stringify({ type: 'item', streamId, value }));
  }

  async close(): Promise<void> {
    this.client?.dispose();
    for (const socket of this.sockets.clients) socket.terminate();
    this.sockets.close(); this.server.closeAllConnections();
    await new Promise<void>(resolve => this.server.close(() => resolve()));
  }
}
