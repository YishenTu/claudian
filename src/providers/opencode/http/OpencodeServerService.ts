import { randomUUID } from 'node:crypto';

import { ProviderTransitionFence } from '@/core/providers/metadata/ProviderTransitionFence';

import { prepareOpencodeLaunchArtifacts } from '../runtime/OpencodeLaunchArtifacts';
import { resolveOpencodeDatabasePath } from '../runtime/OpencodePaths';
import { isRecord, OpencodeHTTPClient, type OpencodeHTTPEvent, pollOpencodeUntil } from './OpencodeHTTPClient';
import { createOpencodeServerConfig, type OpencodeServerConfig } from './OpencodeServerConfig';

type Subscriber = { event: (event: OpencodeHTTPEvent) => void; error: (error: Error) => void; interactive: () => boolean };
interface Server {
  client: OpencodeHTTPClient;
  config: OpencodeServerConfig;
  databasePath: string | null;
  subscribers: Set<Subscriber>;
  forms: Map<string, Subscriber>;
  subscription?: Promise<void>;
  close?: Promise<void>;
}

/** Provider-owned native processes. Persistent consumers share by environment and database. */
export class OpencodeServerService {
  private readonly servers = new Map<string, Promise<Server>>();
  private readonly fence = new ProviderTransitionFence();
  private generation = new AbortController();
  private disposal: Promise<void> | null = null;

  async acquire(cliPath: string, cwd: string, environment: NodeJS.ProcessEnv, signal?: AbortSignal): Promise<OpencodeServerLease> {
    do {
      if (!await this.fence.waitUntilAvailable(signal)) throw new Error('OpenCode server service is disposed.');
      // Disposal or a new transition can overtake an already-resolved wait.
    } while (this.fence.isUnavailable());
    const generation = this.generation.signal;
    const databasePath = resolveOpencodeDatabasePath(environment);
    const normalized = { ...environment, ...(databasePath ? { OPENCODE_DB: databasePath } : {}) };
    const ephemeral = databasePath === ':memory:';
    const key = JSON.stringify([cliPath, cwd, Object.entries(normalized).filter(([, value]) => value !== undefined).sort(([a], [b]) => a.localeCompare(b)), ephemeral ? randomUUID() : '']);
    for (;;) {
      generation.throwIfAborted();
      signal?.throwIfAborted();
      let pending = this.servers.get(key);
      if (!pending) {
        pending = this.create(cliPath, cwd, normalized, generation);
        this.servers.set(key, pending);
        void pending.catch(() => { if (this.servers.get(key) === pending) this.servers.delete(key); });
      }
      const server = await pending;
      if (generation.aborted || signal?.aborted) {
        if (ephemeral) {
          if (this.servers.get(key) === pending) this.servers.delete(key);
          await this.close(server);
        }
        generation.throwIfAborted();
        signal?.throwIfAborted();
      }
      if (!server.client.isReusable() || server.close) {
        if (this.servers.get(key) === pending) this.servers.delete(key);
        await this.close(server, new Error('OpenCode server is no longer available.'));
        continue;
      }
      return new OpencodeServerLease(server, async () => {
        if (ephemeral) {
          if (this.servers.get(key) === pending) this.servers.delete(key);
          await this.close(server);
        }
      }, error => this.close(server, error));
    }
  }

  beginTransition(): Promise<void> {
    this.fence.beginTransition();
    return this.invalidate();
  }

  endTransition(): void { this.fence.endTransition(); }

  async invalidate(): Promise<void> {
    this.fence.beginTransition();
    const previous = [...this.servers.values()];
    this.servers.clear();
    this.generation.abort();
    this.generation = new AbortController();
    try {
      await Promise.all(previous.map(async pending => {
        const server = await pending.catch(() => null);
        if (server) await this.close(server, new Error('OpenCode server configuration changed.'));
      }));
    } finally { this.fence.endTransition(); }
  }

  dispose(): Promise<void> {
    this.fence.dispose();
    return this.disposal ??= this.invalidate();
  }

  private async create(cliPath: string, cwd: string, environment: NodeJS.ProcessEnv, signal: AbortSignal): Promise<Server> {
    // Leases register agents with their own instructions; base prompt files are placeholders.
    const artifacts = await prepareOpencodeLaunchArtifacts({ workspaceRoot: cwd, runtimeEnv: environment, nativeVersion: 2, preserveExistingPrompts: true });
    signal.throwIfAborted();
    const config = await createOpencodeServerConfig(cwd, environment);
    const client = new OpencodeHTTPClient(cliPath, cwd, { ...environment, OPENCODE_CONFIG: config.file, OPENCODE_CONFIG_CONTENT: artifacts.configContent });
    const server: Server = { client, config, databasePath: artifacts.databasePath, subscribers: new Set(), forms: new Map() };
    try {
      await config.initialize(error => { void this.close(server, error); });
      signal.throwIfAborted();
      return server;
    } catch (error) { await this.close(server); throw error; }
  }

  private close(server: Server, error?: Error): Promise<void> {
    if (server.close) return server.close;
    server.close = (async () => {
      if (error) await Promise.allSettled([...server.subscribers].map(async subscriber => subscriber.error(error)));
      server.subscribers.clear();
      server.forms.clear();
      await server.client.dispose();
      await server.config.dispose();
    })();
    return server.close;
  }
}

/** A consumer can release its requests and subscription without closing its peers' process. */
export class OpencodeServerLease {
  private readonly controller = new AbortController();
  private subscriber?: Subscriber;
  private readonly agentIds: string[] = [];
  private disposal?: Promise<void>;

  constructor(private readonly server: Server, private readonly release: () => Promise<void>, private readonly failServer: (error: Error) => Promise<void>) {}

  get databasePath(): string | null { return this.server.databasePath; }
  signal(signal?: AbortSignal): AbortSignal { return this.server.client.signal(AbortSignal.any([this.controller.signal, ...(signal ? [signal] : [])])); }
  isReusable(): boolean { return !this.controller.signal.aborted && this.server.client.isReusable(); }
  request<T = unknown>(route: string, options: Parameters<OpencodeHTTPClient['request']>[1] = {}): Promise<T> {
    return this.server.client.request<T>(route, { ...options, signal: this.signal(options?.signal) });
  }

  /** Newer V2 integration reads wait for plugin/account activation before returning. */
  async waitForActivation(signal?: AbortSignal): Promise<void> {
    const ownedSignal = this.signal(signal);
    try {
      await this.request('/api/integration', { signal: ownedSignal, timeoutMs: 8_000 });
    } catch {
      // Readiness is best-effort: retain catalog polling for older versions or stalled plugins.
      ownedSignal.throwIfAborted();
    }
  }

  async subscribe(event: Subscriber['event'], error: Subscriber['error'], interactive: Subscriber['interactive']): Promise<void> {
    this.controller.signal.throwIfAborted();
    const subscriber = { event, error, interactive };
    this.subscriber = subscriber;
    this.server.subscribers.add(subscriber);
    await subscribeToServer(this.server, this.failServer);
    this.controller.signal.throwIfAborted();
  }

  async refreshGlobalForms(): Promise<void> {
    const inventory = await this.request<{ data: Record<string, unknown>[] }>('/api/form');
    for (const form of inventory.data) {
      if (form.sessionID === 'global') dispatchServerEvent(this.server, { type: 'form.created', data: { form } });
    }
  }

  /** Copies native base agents under session-owned ids so instructions never leak across sessions. */
  async registerAgents(bases: readonly string[], system: string): Promise<Record<string, string>> {
    const signal = this.signal();
    const read = (): Promise<{ data: Record<string, unknown>[] }> => this.request('/api/agent', { signal });
    const catalog = await pollOpencodeUntil(read, current => bases.every(base => current.data.some(agent => agent.id === base)), 10_000, signal);
    const mapping: Record<string, string> = {}, definitions: Record<string, Record<string, unknown>> = {};
    for (const base of bases) {
      const agent = catalog.data.find(agent => agent.id === base);
      if (!agent) throw new Error(`OpenCode managed agent is unavailable: ${base}`);
      const id = `${base}-${randomUUID()}`;
      const { id: _id, name: _name, model, ...definition } = agent;
      mapping[base] = id;
      definitions[id] = { ...definition, ...(isRecord(model) && typeof model.providerID === 'string' && typeof model.id === 'string' ? { model: `${model.providerID}/${model.id}` } : {}), system };
      this.agentIds.push(id);
    }
    await this.server.config.add(definitions);
    const isLoaded = (current: { data: Record<string, unknown>[] }): boolean => Object.values(mapping)
      .every(id => current.data.some(agent => agent.id === id && agent.system === system));
    if (!isLoaded(await pollOpencodeUntil(read, isLoaded, 10_000, signal))) throw new Error('OpenCode did not load the session system instructions.');
    return mapping;
  }

  dispose(): Promise<void> {
    if (this.disposal) return this.disposal;
    this.controller.abort();
    if (this.subscriber) this.server.subscribers.delete(this.subscriber);
    this.disposal = (async () => {
      for (const [id, owner] of this.server.forms) {
        if (owner !== this.subscriber) continue;
        this.server.forms.delete(id);
        await this.server.client.request(`/api/session/global/form/${encodeURIComponent(id)}`, { method: 'DELETE' }).catch(() => undefined);
      }
      try { await this.server.config.remove(this.agentIds); } finally { await this.release(); }
    })();
    return this.disposal;
  }
}

/** Shared stream callbacks retain the server, never the first subscribing lease. */
async function subscribeToServer(server: Server, failServer: (error: Error) => Promise<void>): Promise<void> {
  server.subscription ??= server.client.subscribe(event => dispatchServerEvent(server, event), error => { void failServer(error); });
  try { await server.subscription; }
  catch (error) { await failServer(error instanceof Error ? error : new Error(String(error))); throw error; }
}

function dispatchServerEvent(server: Server, event: OpencodeHTTPEvent): void {
  const form = isRecord(event.data.form) ? event.data.form : undefined;
  const sessionId = form?.sessionID ?? event.data.sessionID;
  if (sessionId === 'global') {
    const id = String(form?.id ?? event.data.requestID ?? event.data.id);
    if (event.type === 'form.created') {
      if (server.forms.has(id)) return;
      const owner = [...server.subscribers].find(subscriber => subscriber.interactive());
      if (!owner) return;
      server.forms.set(id, owner);
      owner.event(event);
    } else {
      server.forms.get(id)?.event(event);
      if (event.type === 'form.replied' || event.type === 'form.cancelled') server.forms.delete(id);
    }
    return;
  }
  for (const subscriber of server.subscribers) subscriber.event(event);
}

/** Borrows the shared service when available; otherwise owns one for this call only. */
export async function withOpencodeServerLease<T>(
  shared: OpencodeServerService | null | undefined, cliPath: string, cwd: string, environment: NodeJS.ProcessEnv,
  use: (lease: OpencodeServerLease) => Promise<T>,
): Promise<T> {
  const service = shared ?? new OpencodeServerService();
  try {
    const lease = await service.acquire(cliPath, cwd, environment);
    try { return await use(lease); } finally { await lease.dispose(); }
  } finally {
    if (!shared) await service.dispose();
  }
}
