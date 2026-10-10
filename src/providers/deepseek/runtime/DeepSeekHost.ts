import { ProviderTransitionFence } from '@/core/providers/metadata/ProviderTransitionFence';

import type { DeepSeekReader,DeepSeekRemoteClient } from '../remote/DeepSeekRemoteClient';
import type { DeepSeekPreset } from '../types';
import { type DeepSeekHostProcess, type DeepSeekLaunchOptions,getDeepSeekHome } from './DeepSeekHostProcess';
import { DeepSeekRoster } from './DeepSeekRoster';

export type DeepSeekProcess = Pick<DeepSeekHostProcess, 'client' | 'onExit' | 'dispose' | 'writePrompt' | 'writeCodeMode'>;
export type DeepSeekProcessFactory = (options: DeepSeekLaunchOptions, signal: AbortSignal) => Promise<DeepSeekProcess>;
export type DeepSeekHostLoss = 'process-exited' | 'transport';

/** One attachment to the running Host generation. Releasing it never stops native work. */
export interface DeepSeekHostLease {
  readonly client: DeepSeekRemoteClient;
  readonly roster: DeepSeekRoster;
  readonly home: string;
  writePrompt(preset: DeepSeekPreset, text: string): Promise<void>;
  /** Shared by every chat agent of this generation; each applies it at its next turn. */
  writeCodeMode(enabled: boolean): Promise<void>;
  /** Exclusive claim of a native session; its interactions are delivered here until release. */
  claim(sessionId: string, deliver: (event: Record<string, unknown>) => void): void;
  /** Fires once if the generation dies while attached. */
  onLost(listener: (loss: DeepSeekHostLoss, error: Error) => void): () => void;
  release(): void;
}

interface Generation {
  readonly abort: AbortController;
  readonly ready: Promise<{ readonly process: DeepSeekProcess; readonly roster: DeepSeekRoster; readonly home: string }>;
  readonly lost: Set<(loss: DeepSeekHostLoss, error: Error) => void>;
  users: number;
  idleTimer?: number;
  retirement?: Promise<void>;
  reconnect?: Promise<void>;
}

/** Native reads that never activate a saved session or take its writer. */
const COLD_METHODS = new Set([
  'session/list', 'session/projections', 'session/page', 'session/attachment',
  'session/modelCatalog', 'skills/list',
]);
const RECONNECT_TIMEOUT_MS = 15_000;

/**
 * Workspace-owned shared native Host. It owns the process, transport, roster and session claims;
 * execution sessions attach to it and never start, reconnect or stop processes themselves.
 */
export class DeepSeekHost {
  private current?: Generation;
  private readonly retiring = new Set<Promise<void>>();
  private readonly fence = new ProviderTransitionFence();

  constructor(
    private readonly launch: () => Promise<DeepSeekLaunchOptions>,
    private readonly spawn: DeepSeekProcessFactory,
    private readonly idleMs = 60_000,
  ) {}

  /** Starts the process ahead of first use; it then follows the ordinary idle policy. */
  async start(): Promise<void> {
    const generation = await this.enter();
    try { await generation.ready; } finally { this.leave(generation); }
  }

  async attach(signal?: AbortSignal): Promise<DeepSeekHostLease> {
    const generation = await this.enter(signal);
    let ready;
    try { ready = await abortable(generation.ready, signal); } catch (error) { this.leave(generation); throw error; }
    // Loss can land between startup and this continuation; its listeners have already run.
    if (generation.retirement) { this.leave(generation); throw new Error('DeepSeek process exited during startup.'); }
    const { process, roster, home } = ready;
    const claims: Array<() => void> = [];
    const lost = new Set<(loss: DeepSeekHostLoss, error: Error) => void>();
    const relay = (loss: DeepSeekHostLoss, error: Error): void => { for (const listener of [...lost]) listener(loss, error); lost.clear(); };
    generation.lost.add(relay);
    let released = false;
    return {
      client: process.client, roster, home,
      writePrompt: (preset, text) => process.writePrompt(preset, text),
      writeCodeMode: enabled => process.writeCodeMode(enabled),
      claim: (sessionId, deliver) => {
        if (released) throw new Error('DeepSeek Host lease is released.');
        claims.push(roster.claim(sessionId, deliver));
      },
      onLost: listener => { lost.add(listener); return () => lost.delete(listener); },
      release: () => {
        if (released) return;
        released = true;
        for (const off of claims.splice(0)) off();
        lost.clear(); generation.lost.delete(relay);
        this.leave(generation);
      },
    };
  }

  /** Cold, non-activating reads against the native store at `home`. History browsing never claims a writer. */
  async read<T>(operation: (reader: DeepSeekReader, home: string) => Promise<T>, signal?: AbortSignal): Promise<T> {
    const generation = await this.enter(signal);
    try {
      const { process, home } = await abortable(generation.ready, signal);
      const reader: DeepSeekReader = {
        call: (method, args, options = {}) => {
          if (!COLD_METHODS.has(method)) return Promise.reject(new Error(`DeepSeek history reads cannot call ${method}.`));
          const signals = [signal, options.signal].filter((value): value is AbortSignal => !!value);
          return process.client.call(method, args, { ...options, ...(signals.length ? { signal: AbortSignal.any(signals) } : {}) });
        },
      };
      return await abortable(operation(reader, home), signal);
    } finally {
      this.leave(generation);
    }
  }

  async beginTransition(): Promise<void> {
    this.fence.beginTransition();
    await this.stop(new Error('DeepSeek provider settings changed.'));
  }

  endTransition(): void { this.fence.endTransition(); }

  async dispose(): Promise<void> {
    this.fence.dispose();
    await this.stop(new Error('DeepSeek is shutting down.'));
  }

  private async enter(signal?: AbortSignal): Promise<Generation> {
    for (;;) {
      if (!await this.fence.waitUntilAvailable(signal)) throw new Error('DeepSeek is unavailable.');
      signal?.throwIfAborted();
      // A replacement must not claim sessions while a retiring process still holds their writers.
      if (!this.current && this.retiring.size) { await Promise.all(this.retiring); continue; }
      const generation = this.current ?? this.begin();
      if (generation.idleTimer !== undefined) window.clearTimeout(generation.idleTimer);
      generation.idleTimer = undefined;
      generation.users++;
      return generation;
    }
  }

  private leave(generation: Generation): void {
    generation.users--;
    // A failed startup is already forgotten; only the current process idles out.
    if (generation.users > 0 || generation.retirement || generation !== this.current) return;
    generation.idleTimer = window.setTimeout(() => { void this.retire(generation); }, this.idleMs);
  }

  private begin(): Generation {
    const abort = new AbortController();
    const generation: Generation = { abort, lost: new Set(), users: 0, ready: this.boot(abort.signal, () => generation) };
    // A failed startup leaves no generation behind; the next caller starts fresh.
    generation.ready.catch(() => { if (this.current === generation) this.current = undefined; });
    this.current = generation;
    return generation;
  }

  private async boot(signal: AbortSignal, self: () => Generation): Promise<{ process: DeepSeekProcess; roster: DeepSeekRoster; home: string }> {
    const options = await this.launch();
    const process = await this.spawn(options, signal);
    if (signal.aborted) { await process.dispose(); throw new Error('DeepSeek startup cancelled.'); }
    const roster = new DeepSeekRoster(process.client, error => this.lose(self(), 'transport', error));
    process.onExit(() => this.lose(self(), 'process-exited', new Error('DeepSeek process exited.')));
    process.client.onDisconnect(() => this.reconnect(self(), process, roster));
    try { await roster.start(); } catch (error) { roster.dispose(); await process.dispose(); throw error; }
    return { process, roster, home: getDeepSeekHome(options.environment) };
  }

  private reconnect(generation: Generation, process: DeepSeekProcess, roster: DeepSeekRoster): void {
    if (generation !== this.current || generation.reconnect) return;
    roster.reset();
    const signal = AbortSignal.any([generation.abort.signal, AbortSignal.timeout(RECONNECT_TIMEOUT_MS)]);
    generation.reconnect = process.client.connect(signal).then(() => roster.start())
      .catch(error => this.lose(generation, 'transport', error instanceof Error ? error : new Error('DeepSeek reconnection failed.')))
      .finally(() => { generation.reconnect = undefined; });
  }

  private lose(generation: Generation, loss: DeepSeekHostLoss, error: Error): void {
    if (generation.retirement) return;
    for (const listener of [...generation.lost]) listener(loss, error);
    generation.lost.clear();
    void this.retire(generation);
  }

  private async stop(error: Error): Promise<void> {
    if (this.current) this.lose(this.current, 'process-exited', error);
    await Promise.all(this.retiring);
  }

  private retire(generation: Generation): Promise<void> {
    if (generation.retirement) return generation.retirement;
    if (this.current === generation) this.current = undefined;
    if (generation.idleTimer !== undefined) window.clearTimeout(generation.idleTimer);
    generation.abort.abort();
    const retirement = generation.ready.then(({ process, roster }) => { roster.dispose(); return process.dispose(); }, () => undefined);
    generation.retirement = retirement;
    this.retiring.add(retirement);
    void retirement.finally(() => this.retiring.delete(retirement));
    return retirement;
  }
}

function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(new Error('DeepSeek request cancelled.'));
  return new Promise((resolve, reject) => {
    const aborted = (): void => reject(new Error('DeepSeek request cancelled.'));
    signal.addEventListener('abort', aborted, { once: true });
    promise.then(
      value => { signal.removeEventListener('abort', aborted); resolve(value); },
      error => { signal.removeEventListener('abort', aborted); reject(error instanceof Error ? error : new Error('DeepSeek request failed.', { cause: error })); },
    );
  });
}
