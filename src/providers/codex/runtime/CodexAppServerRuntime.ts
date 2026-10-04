import { Notice } from 'obsidian';

import type { ProviderHost } from '@/core/providers/ProviderHost';
import type { ProviderTransitionOwnerContext } from '@/core/providers/types';

import { CodexMetadataTransitionGate } from '../metadata/CodexMetadataTransitionGate';
import { getCodexProviderSettings } from '../settings';
import { CodexAppServerProcess } from './CodexAppServerProcess';
import { initializeCodexAppServerTransport, resolveCodexAppServerLaunchSpec } from './codexAppServerSupport';
import type { CodexLaunchSpec } from './codexLaunchTypes';
import { CodexRPCTransport } from './CodexRPCTransport';
import { type CodexRuntimeContext, createCodexRuntimeContext } from './CodexRuntimeContext';
import { CodexThreadRouter } from './CodexThreadRouter';
import { type CodexThreadObserver, CodexThreadScope } from './CodexThreadScope';

export interface CodexAppServerLease {
  readonly connection: CodexAppServerConnection;
  release(): Promise<void>;
}

/** One native process generation. Consumers release leases, never its transport. */
export class CodexAppServerConnection {
  readonly process: CodexAppServerProcess;
  readonly transport: CodexRPCTransport;
  readonly threads: CodexThreadRouter;
  readonly initialized: Promise<CodexRuntimeContext>;
  readonly ready: Promise<void>;
  private pluginRefresh: Promise<void> | null = null;
  private pluginRefreshAt = 0;
  private pluginWarningShown = false;
  private users = 0;
  private retired = false;
  private closed = false;
  private shutdownPromise: Promise<void> | null = null;
  private readonly retireListeners = new Set<() => void>();
  private readonly exitListeners = new Set<() => void>();

  constructor(
    readonly launchSpec: CodexLaunchSpec,
    readonly fingerprint: string,
    private readonly invalidate: () => void,
    private readonly stopped: () => void,
    private readonly skillsChanged: () => void,
    private readonly warn: (message: string) => void,
  ) {
    const process = this.process = new CodexAppServerProcess(launchSpec);
    const transport = this.transport = new CodexRPCTransport(process);
    this.threads = new CodexThreadRouter(transport);
    this.process.onExit(() => {
      this.#exited();
      if (!this.shutdownPromise) this.stopped();
    });
    this.transport.onNotification('skills/changed', skillsChanged);
    this.initialized = (async () => {
      process.start();
      transport.start();
      const result = await initializeCodexAppServerTransport(transport);
      return createCodexRuntimeContext(launchSpec, result);
    })();
    this.ready = this.initialized.then(() => this.#reconcilePlugins('startup'));
    // Startup may be triggered by model discovery, which waits only for initialize.
    void this.ready.catch(() => undefined);
    void this.initialized.catch(() => this.shutdown()).catch(() => undefined);
  }

  /** On-demand refresh; callers can keep using the current snapshot while it runs. */
  refreshPlugins(force = false): Promise<void> {
    if (this.pluginRefresh) return this.pluginRefresh;
    if (!this.isAlive() || this.retired || (!force && Date.now() - this.pluginRefreshAt < 30_000)) return Promise.resolve();
    const lease = this.retain();
    const refresh = this.#reconcilePlugins('skills-list')
      .then(() => this.skillsChanged())
      .finally(async () => {
        this.pluginRefresh = null;
        await lease.release();
      });
    this.pluginRefresh = refresh;
    return refresh;
  }

  async #reconcilePlugins(reason: string): Promise<void> {
    try {
      const result = await this.transport.request<{
        failedRemotePluginIds?: string[];
        failedMaterializationRemotePluginIds?: string[];
      }>('plugin/reconcile', { reason });
      if (result.failedRemotePluginIds?.length || result.failedMaterializationRemotePluginIds?.length) {
        this.#warnPlugins('Codex could not sync some plugins. Skills and apps may be incomplete for this server session.');
      }
    } catch (error) {
      if (!this.closed) {
        const detail = error instanceof Error ? error.message : String(error);
        this.#warnPlugins(`Codex plugin sync failed. Continuing with potentially incomplete skills and apps. ${detail}`);
      }
    } finally {
      this.pluginRefreshAt = Date.now();
    }
    this.assertAlive();
  }

  #warnPlugins(message: string): void {
    if (this.pluginWarningShown) return;
    this.pluginWarningShown = true;
    this.warn(message);
  }

  isAlive(): boolean { return !this.closed && this.process.isAlive(); }
  isRetired(): boolean { return this.retired; }

  assertAlive(): void {
    if (!this.isAlive()) throw new Error('Codex CLI app-server connection is closed.');
  }

  retain(): CodexAppServerLease {
    this.assertAlive();
    this.users++;
    let released = false;
    return {
      connection: this,
      release: async () => {
        if (released) return;
        released = true;
        this.users--;
        if (this.retired && this.users === 0) await this.shutdown();
      },
    };
  }

  createThreadScope(observer: CodexThreadObserver): CodexThreadScope {
    return new CodexThreadScope(this, observer);
  }

  onRetired(listener: () => void): () => void {
    this.retireListeners.add(listener);
    return () => this.retireListeners.delete(listener);
  }

  onExit(listener: () => void): () => void {
    this.exitListeners.add(listener);
    return () => this.exitListeners.delete(listener);
  }

  retire(): void {
    if (this.retired) return;
    this.retired = true;
    for (const listener of [...this.retireListeners]) listener();
    if (this.users === 0) void this.shutdown().catch(() => undefined);
  }

  shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.shutdownPromise = Promise.resolve().then(() => this.process.shutdown()).finally(this.stopped);
    this.#exited();
    return this.shutdownPromise;
  }

  #exited(): void {
    if (this.closed) return;
    this.closed = true;
    this.threads.close();
    this.transport.dispose();
    this.invalidate();
    for (const listener of [...this.exitListeners]) listener();
    this.exitListeners.clear();
    this.retireListeners.clear();
  }
}

/** Provider-owned startup, readiness, and process retirement shared by all Codex consumers. */
export class CodexAppServerRuntime {
  private current: CodexAppServerConnection | null = null;
  private readonly connections = new Set<CodexAppServerConnection>();
  private readonly invalidationListeners = new Set<() => void>();
  private readonly gate = new CodexMetadataTransitionGate();
  private generation = 0;
  private disposed = false;
  private disposePromise: Promise<void> | null = null;

  constructor(
    private readonly plugin: ProviderHost,
    private readonly warn: (message: string) => void = message => { new Notice(message); },
  ) {}

  onSkillsChanged(listener: () => void): () => void {
    this.invalidationListeners.add(listener);
    return () => this.invalidationListeners.delete(listener);
  }

  async acquire(options: {
    readiness?: 'initialized' | 'plugins';
    signal?: AbortSignal;
    context?: ProviderTransitionOwnerContext;
  } = {}): Promise<CodexAppServerLease> {
    const { signal, context } = options;
    signal?.throwIfAborted();
    if (!context?.providerTransitionOwner && !await this.gate.waitUntilAvailable(signal)) {
      throw new Error('Codex runtime is disposed.');
    }
    this.#assertAvailable();
    const generation = this.generation;
    const launchSpec = await waitForCodexOperation(
      resolveCodexAppServerLaunchSpec(this.plugin, 'codex', context), signal,
    );
    this.#assertAvailable();
    if (generation !== this.generation) return this.acquire(options);
    const fingerprint = fingerprintLaunchSpec(launchSpec);
    let connection = this.current;
    if (!connection?.isAlive() || connection.fingerprint !== fingerprint) {
      this.#retireCurrent();
      connection = new CodexAppServerConnection(
        launchSpec, fingerprint,
        () => {
          if (this.current === connection) {
            this.current = null;
            this.#invalidate();
          }
        },
        () => { this.connections.delete(connection!); },
        () => { if (this.current === connection) this.#invalidate(); },
        this.warn,
      );
      this.connections.add(connection);
      this.current = connection;
    }
    const lease = connection.retain();
    try {
      await waitForCodexOperation<unknown>(options.readiness === 'initialized' ? connection.initialized : connection.ready, signal);
      connection.assertAlive();
      signal?.throwIfAborted();
      if (generation !== this.generation && !context?.providerTransitionOwner) {
        await lease.release();
        return this.acquire(options);
      }
      return lease;
    } catch (error) {
      await lease.release();
      throw error;
    }
  }

  async start(): Promise<void> {
    const lease = await this.acquire();
    await lease.release();
  }

  beginEnvironmentTransition(): void {
    this.generation++;
    this.gate.beginTransition();
    this.#invalidate();
  }

  async endEnvironmentTransition(): Promise<void> {
    try {
      if (!getCodexProviderSettings(this.plugin.settings).enabled) {
        await this.stop();
      } else if (this.current) {
        const spec = await resolveCodexAppServerLaunchSpec(this.plugin, 'codex', { providerTransitionOwner: true });
        if (this.current?.fingerprint !== fingerprintLaunchSpec(spec)) this.#retireCurrent();
      }
    } finally {
      this.gate.endTransition();
    }
  }

  async stop(): Promise<void> {
    this.generation++;
    this.current = null;
    this.#invalidate();
    const connections = [...this.connections];
    await Promise.all(connections.map(connection => connection.threads.stop()));
    await Promise.all(connections.map(connection => connection.shutdown()));
  }

  dispose(): Promise<void> {
    if (this.disposePromise) return this.disposePromise;
    this.disposed = true;
    this.gate.dispose();
    this.disposePromise = this.stop();
    this.invalidationListeners.clear();
    return this.disposePromise;
  }

  #assertAvailable(): void {
    if (this.disposed) throw new Error('Codex runtime is disposed.');
    if (!getCodexProviderSettings(this.plugin.settings).enabled) throw new Error('Codex is disabled.');
  }

  #retireCurrent(): void {
    const previous = this.current;
    this.current = null;
    if (!previous) return;
    this.#invalidate();
    previous.retire();
  }

  #invalidate(): void {
    for (const listener of this.invalidationListeners) listener();
  }
}

function fingerprintLaunchSpec(spec: CodexLaunchSpec): string {
  return JSON.stringify([
    spec.command, spec.args, spec.spawnCwd, spec.targetCwd, spec.target,
    Object.entries(spec.env).sort(([left], [right]) => left.localeCompare(right)),
  ]);
}

/** Cancels only this caller's wait; shared startup and native mutations keep their identity. */
export async function waitForCodexOperation<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return operation;
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => reject(signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason)));
    signal.addEventListener('abort', abort, { once: true });
    void operation.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
