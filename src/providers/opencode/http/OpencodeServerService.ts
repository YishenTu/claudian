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

interface ServerEntry {
  readonly promise: Promise<Server>;
  /** The `servers` key; in-memory launches add a unique suffix to `launchKey`. */
  readonly key: string;
  readonly compatibility: string;
  readonly launchKey: string;
  retainWhenIdle: boolean;
  consumers: number;
  retired: boolean;
  readonly retirementListeners: Set<() => void>;
  readonly supersessionListeners: Set<() => void>;
}

/** Provider-owned native processes. Persistent consumers share by environment and database. */
export class OpencodeServerService {
  private readonly servers = new Map<string, ServerEntry>();
  private readonly draining = new Set<ServerEntry>();
  private readonly closing = new Set<Promise<void>>();
  private readonly fence = new ProviderTransitionFence();
  private generation = new AbortController();
  private disposal: Promise<void> | null = null;
  /** The committed default launch; retained when idle and never evicted as an idle peer. */
  private currentLaunch: { compatibility: string; key: string } | null = null;

  /** Retained execution kernels must fence new turns as well as new leases. */
  async waitUntilAvailable(signal?: AbortSignal): Promise<void> {
    do {
      if (!await this.fence.waitUntilAvailable(signal)) throw new Error('OpenCode server service is disposed.');
      // Disposal or a new transition can overtake an already-resolved wait.
    } while (this.fence.isUnavailable());
  }

  acquire(cliPath: string, cwd: string, environment: NodeJS.ProcessEnv, signal?: AbortSignal): Promise<OpencodeServerLease> {
    return this.borrow(cliPath, cwd, environment, signal, false);
  }

  /** Owned native deletion must finish before the transition can reopen normal admission. */
  acquireCleanup(cliPath: string, cwd: string, environment: NodeJS.ProcessEnv): Promise<OpencodeServerLease> {
    return this.borrow(cliPath, cwd, environment, undefined, true);
  }

  private async borrow(cliPath: string, cwd: string, environment: NodeJS.ProcessEnv, signal: AbortSignal | undefined, cleanup: boolean): Promise<OpencodeServerLease> {
    if (this.disposal) throw new Error('OpenCode server service is disposed.');
    if (!cleanup) await this.waitUntilAvailable(signal);
    const generation = this.generation.signal;
    const launch = normalizeLaunch(cliPath, cwd, environment);
    const { compatibility, ephemeral, normalized } = launch;
    const obsolete = this.currentLaunch !== null && this.currentLaunch.compatibility !== compatibility;
    const key = ephemeral ? JSON.stringify([launch.key, randomUUID()]) : launch.key;
    for (;;) {
      generation.throwIfAborted();
      signal?.throwIfAborted();
      let entry = this.servers.get(key) ?? ((cleanup || obsolete) ? [...this.draining].find(draining => draining.key === key) : undefined);
      if (!entry) {
        entry = {
          promise: this.create(cliPath, cwd, normalized, generation),
          key,
          compatibility,
          launchKey: launch.key,
          retainWhenIdle: false,
          consumers: 0,
          retired: obsolete,
          retirementListeners: new Set(),
          supersessionListeners: new Set(),
        };
        if (obsolete) this.draining.add(entry);
        else this.servers.set(key, entry);
        // Observe failure immediately, including while older idle servers retire.
        const pendingEntry = entry;
        void entry.promise.catch(() => {
          if (this.servers.get(key) === pendingEntry) this.servers.delete(key);
        });
      }
      // Pending acquisitions own a reservation too; cancellation cannot close a peer's server.
      entry.consumers += 1;
      if (!ephemeral && !cleanup) entry.retainWhenIdle = true;
      let handedOff = false;
      try {
        if (!cleanup && !obsolete) await Promise.all([...this.servers].flatMap(([idleKey, idle]) => (
          idle.consumers === 0 && idleKey !== this.currentLaunch?.key ? [this.retire(idle)] : []
        )));
        const server = await entry.promise;
        generation.throwIfAborted();
        signal?.throwIfAborted();
        if (!server.client.isReusable() || server.close) {
          await this.retire(entry, new Error('OpenCode server is no longer available.'));
          continue;
        }
        const lease = this.lease(entry, server);
        handedOff = true;
        return lease;
      } finally {
        if (!handedOff) await this.release(entry);
      }
    }
  }

  private lease(entry: ServerEntry, server: Server): OpencodeServerLease {
    return new OpencodeServerLease(
      server,
      () => this.release(entry),
      error => this.retire(entry, error),
      (event, listener) => {
        const listeners = event === 'retired' ? entry.retirementListeners : entry.supersessionListeners;
        listeners.add(listener);
        if (event === 'retired' ? entry.retired : this.isSuperseded(entry)) listener();
        return () => listeners.delete(listener);
      },
      () => {
        entry.consumers += 1;
        return this.lease(entry, server);
      },
    );
  }

  /**
   * Commit the default launch. Incompatible generations stop admitting consumers without
   * interrupting native work; compatible database bindings keep their process.
   */
  reconcileLaunch(cliPath: string, cwd: string, environment: NodeJS.ProcessEnv): void {
    const launch = normalizeLaunch(cliPath, cwd, environment);
    this.currentLaunch = { compatibility: launch.compatibility, key: launch.key };
    for (const entry of [...this.servers.values(), ...this.draining]) {
      if (this.isSuperseded(entry)) for (const listener of [...entry.supersessionListeners]) listener();
    }
    for (const [key, entry] of this.servers) {
      if (entry.compatibility === launch.compatibility) {
        if (entry.consumers === 0 && key !== launch.key) void this.retire(entry);
        continue;
      }
      this.servers.delete(key);
      entry.retired = true;
      this.draining.add(entry);
      for (const listener of [...entry.retirementListeners]) listener();
      if (entry.consumers === 0) void this.retire(entry);
    }
  }

  /** Only the committed default launch may publish provider-wide metadata. */
  private isSuperseded(entry: ServerEntry): boolean {
    return this.currentLaunch !== null && entry.launchKey !== this.currentLaunch.key;
  }

  private async release(entry: ServerEntry): Promise<void> {
    entry.consumers -= 1;
    if (entry.consumers !== 0) return;
    // Retain one idle persistent server for repeated catalog/history calls: the committed
    // default launch, or a lone server before any launch is committed.
    const retained = this.currentLaunch ? entry.key === this.currentLaunch.key : this.servers.size === 1;
    if (!entry.retainWhenIdle || !retained || this.servers.get(entry.key) !== entry) {
      await this.retire(entry);
    }
  }

  private retire(entry: ServerEntry, error?: Error): Promise<void> {
    if (this.servers.get(entry.key) === entry) this.servers.delete(entry.key);
    this.draining.delete(entry);
    entry.retirementListeners.clear();
    entry.supersessionListeners.clear();
    const closing = entry.promise.then(server => this.close(server, error), () => undefined);
    this.closing.add(closing);
    void closing.then(
      () => this.closing.delete(closing),
      () => this.closing.delete(closing),
    );
    return closing;
  }

  beginTransition(): void { this.fence.beginTransition(); }

  endTransition(): void { this.fence.endTransition(); }

  async invalidate(): Promise<void> {
    this.fence.beginTransition();
    const previous = [...this.servers.values(), ...this.draining];
    this.generation.abort();
    this.generation = new AbortController();
    this.currentLaunch = null;
    try {
      await Promise.all([
        ...previous.map(entry => this.retire(entry, new Error('OpenCode server configuration changed.'))),
        ...this.closing,
      ]);
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
  private readonly unsubscribers = new Set<() => void>();

  constructor(
    private readonly server: Server,
    private readonly release: () => Promise<void>,
    private readonly failServer: (error: Error) => Promise<void>,
    private readonly subscribeGeneration: (event: 'retired' | 'superseded', listener: () => void) => () => void,
    private readonly retainLease: () => OpencodeServerLease,
  ) {}

  onRetired(listener: () => void): void {
    this.controller.signal.throwIfAborted();
    this.unsubscribers.add(this.subscribeGeneration('retired', listener));
  }

  /** Fires once another launch becomes the default; the process and its sessions stay usable. */
  onSuperseded(listener: () => void): void {
    this.controller.signal.throwIfAborted();
    this.unsubscribers.add(this.subscribeGeneration('superseded', listener));
  }

  /** Cleanup must borrow the exact generation that admitted a native session. */
  retain(): OpencodeServerLease {
    this.controller.signal.throwIfAborted();
    return this.retainLease();
  }

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
    for (const unsubscribe of this.unsubscribers) unsubscribe();
    this.unsubscribers.clear();
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

function normalizeLaunch(cliPath: string, cwd: string, environment: NodeJS.ProcessEnv) {
  const databasePath = resolveOpencodeDatabasePath(environment);
  const normalized = { ...environment, ...(databasePath ? { OPENCODE_DB: databasePath } : {}) };
  const entries = Object.entries(normalized).filter(([, value]) => value !== undefined).sort(([a], [b]) => a.localeCompare(b));
  return {
    normalized,
    ephemeral: databasePath === ':memory:',
    key: JSON.stringify([cliPath, cwd, entries]),
    // Database overrides remain legitimate historical bindings within the current launch environment.
    compatibility: JSON.stringify([cliPath, cwd, entries.filter(([name]) => name !== 'OPENCODE_DB')]),
  };
}
