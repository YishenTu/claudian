import { randomUUID } from 'node:crypto';

import { getInlineEditSystemPrompt } from '@/core/prompt/inlineEdit';
import { buildSystemPrompt } from '@/core/prompt/mainAgent';
import { buildTitleGenerationSystemPrompt, resolveTitleGenerationLocale } from '@/core/prompt/titleGeneration';
import { ProviderTransitionFence } from '@/core/providers/metadata/ProviderTransitionFence';
import type { ProviderHost } from '@/core/providers/ProviderHost';

import type { OpencodeKernelConnectOptions } from '../execution/OpencodeSessionContract';
import { OPENCODE_SAFE_MODE_ID, OPENCODE_YOLO_MODE_ID } from '../modes';
import { AUX_AGENT_IDS, getSystemPromptSettings } from '../runtime/OpencodeExecutionAgents';
import { prepareOpencodeLaunchArtifacts } from '../runtime/OpencodeLaunchArtifacts';
import { resolveOpencodeDatabasePath } from '../runtime/OpencodePaths';
import { isRecord, OpencodeHttpClient, type OpencodeHttpEvent } from './OpencodeHttpClient';
import { createOpencodeServerConfig, type OpencodeServerConfig } from './OpencodeServerConfig';

type Subscriber = { event: (event: OpencodeHttpEvent) => void; error: (error: Error) => void; interactive: () => boolean };
interface Server {
  client: OpencodeHttpClient;
  config: OpencodeServerConfig;
  databasePath: string | null;
  subscribers: Set<Subscriber>;
  forms: Map<string, Subscriber>;
  subscription?: Promise<void>;
  references: number;
  ephemeral: boolean;
  close?: Promise<void>;
}

export interface OpencodeHttpTransport {
  request<T = unknown>(route: string, options?: Parameters<OpencodeHttpClient['request']>[1]): Promise<T>;
}

/** Provider-owned native processes. Persistent consumers share by environment and database. */
export class OpencodeServerService {
  private readonly servers = new Map<string, Promise<Server>>();
  private readonly fence = new ProviderTransitionFence();
  private generation = new AbortController();
  private disposal: Promise<void> | null = null;

  constructor(private readonly plugin: Pick<ProviderHost, 'settings'>) {}

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
        pending = this.create(cliPath, cwd, normalized, ephemeral, generation);
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
      server.references++;
      return new OpencodeServerLease(server, this.plugin, cwd, async () => {
        if (--server.references === 0 && ephemeral) {
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

  private async create(cliPath: string, cwd: string, environment: NodeJS.ProcessEnv, ephemeral: boolean, signal: AbortSignal): Promise<Server> {
    const artifacts = await prepareOpencodeLaunchArtifacts({
      workspaceRoot: cwd, runtimeEnv: environment, nativeVersion: 2,
      settings: getSystemPromptSettings(this.plugin, cwd), titleLocale: resolveTitleGenerationLocale(this.plugin.settings),
    });
    signal.throwIfAborted();
    const config = await createOpencodeServerConfig(cwd, environment);
    const client = new OpencodeHttpClient(cliPath, cwd, { ...environment, OPENCODE_CONFIG: config.file, OPENCODE_CONFIG_CONTENT: artifacts.configContent });
    const server: Server = { client, config, databasePath: artifacts.databasePath, ephemeral, references: 0, subscribers: new Set(), forms: new Map() };
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
export class OpencodeServerLease implements OpencodeHttpTransport {
  private readonly controller = new AbortController();
  private subscriber?: Subscriber;
  private readonly agentIds: string[] = [];
  private disposal?: Promise<void>;

  constructor(private readonly server: Server, private readonly plugin: Pick<ProviderHost, 'settings'>, private readonly cwd: string,
    private readonly release: () => Promise<void>, private readonly failServer: (error: Error) => Promise<void>) {}

  get databasePath(): string | null { return this.server.databasePath; }
  signal(signal?: AbortSignal): AbortSignal { return this.server.client.signal(AbortSignal.any([this.controller.signal, ...(signal ? [signal] : [])])); }
  isReusable(): boolean { return !this.controller.signal.aborted && this.server.client.isReusable(); }
  request<T = unknown>(route: string, options: Parameters<OpencodeHttpClient['request']>[1] = {}): Promise<T> {
    return this.server.client.request<T>(route, { ...options, signal: this.signal(options?.signal) });
  }

  async subscribe(event: Subscriber['event'], error: Subscriber['error'], interactive: Subscriber['interactive']): Promise<void> {
    this.controller.signal.throwIfAborted();
    const subscriber = { event, error, interactive };
    this.subscriber = subscriber;
    this.server.subscribers.add(subscriber);
    this.server.subscription ??= this.server.client.subscribe(event => this.dispatch(event), error => { void this.failServer(error); });
    try { await this.server.subscription; }
    catch (error) { await this.failServer(error instanceof Error ? error : new Error(String(error))); throw error; }
    this.controller.signal.throwIfAborted();
  }

  async refreshGlobalForms(): Promise<void> {
    const inventory = await this.request<{ data: Record<string, unknown>[] }>('/api/form');
    for (const form of inventory.data) {
      if (form.sessionID === 'global') this.dispatch({ type: 'form.created', data: { form } });
    }
  }

  async prepareAgents(options: OpencodeKernelConnectOptions): Promise<Record<string, string>> {
    const profile = options.profile;
    const instructions = options.systemInstructions;
    const system = instructions.kind === 'explicit' ? instructions.instructions
      : profile === 'readonly' ? getInlineEditSystemPrompt(this.cwd)
      : profile === 'passive' ? buildTitleGenerationSystemPrompt(resolveTitleGenerationLocale(this.plugin.settings))
      : buildSystemPrompt(getSystemPromptSettings(this.plugin, this.cwd), { dynamicSections: instructions.dynamicSections ? [...instructions.dynamicSections] : undefined });
    const bases = profile === 'managed' ? [OPENCODE_SAFE_MODE_ID, OPENCODE_YOLO_MODE_ID] : [AUX_AGENT_IDS[profile]];
    let catalog: { data: Record<string, unknown>[] };
    const readyBy = Date.now() + 10_000;
    do {
      catalog = await this.request('/api/agent');
      if (bases.every(base => catalog.data.some(agent => agent.id === base))) break;
      await new Promise(resolve => window.setTimeout(resolve, 25));
    } while (Date.now() < readyBy);
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
    const deadline = Date.now() + 10_000;
    do {
      const current = await this.request<{ data: Record<string, unknown>[] }>('/api/agent');
      if (Object.values(mapping).every(id => current.data.some(agent => agent.id === id && agent.system === system))) return mapping;
      await new Promise(resolve => window.setTimeout(resolve, 25));
    } while (Date.now() < deadline);
    throw new Error('OpenCode did not load the session system instructions.');
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

  private dispatch(event: OpencodeHttpEvent): void {
    const form = isRecord(event.data.form) ? event.data.form : undefined;
    const sessionId = form?.sessionID ?? event.data.sessionID;
    if (sessionId === 'global') {
      const id = String(form?.id ?? event.data.requestID ?? event.data.id);
      if (event.type === 'form.created') {
        if (this.server.forms.has(id)) return;
        const owner = [...this.server.subscribers].find(subscriber => subscriber.interactive());
        if (!owner) return;
        this.server.forms.set(id, owner);
        owner.event(event);
      } else {
        this.server.forms.get(id)?.event(event);
        if (event.type === 'form.replied' || event.type === 'form.cancelled') this.server.forms.delete(id);
      }
      return;
    }
    for (const subscriber of this.server.subscribers) subscriber.event(event);
  }
}
