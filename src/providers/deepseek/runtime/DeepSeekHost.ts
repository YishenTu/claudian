import { randomUUID } from 'node:crypto';

import { ProviderTransitionFence } from '@/core/providers/metadata/ProviderTransitionFence';

import { type DeepSeekReader, type DeepSeekRemoteClient, DeepSeekRemoteError, isRecord } from '../remote/DeepSeekRemoteClient';
import type { DeepSeekPreset } from '../types';
import { DEEPSEEK_EPHEMERAL_PREFIX } from './DeepSeekCompatibility';
import { type DeepSeekHostProcess, type DeepSeekLaunchOptions,getDeepSeekHome } from './DeepSeekHostProcess';
import { DeepSeekRoster } from './DeepSeekRoster';

export type DeepSeekProcess = Pick<DeepSeekHostProcess, 'client' | 'onExit' | 'dispose' | 'writePrompt' | 'writeCodeMode' | 'offerEphemeralFork' | 'readEphemeralReady'>;
export type DeepSeekProcessFactory = (options: DeepSeekLaunchOptions, signal: AbortSignal) => Promise<DeepSeekProcess>;
export type DeepSeekHostLoss = 'process-exited' | 'transport';

/** One attachment to the running Host generation. Releasing it never stops native work. */
export interface DeepSeekHostLease {
  readonly client: DeepSeekRemoteClient;
  readonly roster: DeepSeekRoster;
  readonly home: string;
  /** Identifies the native process; ephemeral sessions exist only inside the generation that created them. */
  readonly generation: number;
  /** Whether this process keeps ephemeral sessions in memory. Without it native would store them. */
  readonly ephemeral: boolean;
  /** A fresh native session id this process keeps in memory; only a process whose plugin is ready hands one out. */
  ephemeralSessionId(): string;
  /**
   * Forks one native session; forks run one at a time per process so an ephemeral fork's token is never shared. The
   * signal only stops the caller waiting: native forks cannot be cancelled, so the Host keeps the token until it settles.
   */
  fork(request: { readonly sessionId: string; readonly atSeq: number }, ephemeral: boolean, signal?: AbortSignal): Promise<string>;
  writePrompt(preset: DeepSeekPreset, text: string): Promise<void>;
  /** Shared by every chat agent of this generation; each applies it at its next turn. */
  writeCodeMode(enabled: boolean): Promise<void>;
  /** Exclusive claim of a native session; its interactions are delivered here until release. */
  claim(sessionId: string, deliver: (event: Record<string, unknown>) => void): void;
  /** Fires once if the generation dies while attached. */
  onLost(listener: (loss: DeepSeekHostLoss, error: Error) => void): () => void;
  release(): void;
}

interface Ready { readonly process: DeepSeekProcess; readonly roster: DeepSeekRoster; readonly home: string; readonly ephemeral: boolean }

interface Generation {
  readonly id: number;
  readonly abort: AbortController;
  readonly ready: Promise<Ready>;
  forks: Promise<unknown>;
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
// Covers native MCP discovery during agent composition; a fork still running after it ends with its process.
const FORK_WATCHDOG_MS = 5 * 60_000;

/**
 * Workspace-owned shared native Host. It owns the process, transport, roster and session claims;
 * execution sessions attach to it and never start, reconnect or stop processes themselves.
 */
export class DeepSeekHost {
  private current?: Generation;
  private generations = 0;
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
    const { process, roster, home, ephemeral } = ready;
    const claims: Array<() => void> = [];
    const lost = new Set<(loss: DeepSeekHostLoss, error: Error) => void>();
    const relay = (loss: DeepSeekHostLoss, error: Error): void => { for (const listener of [...lost]) listener(loss, error); lost.clear(); };
    generation.lost.add(relay);
    let released = false;
    return {
      client: process.client, roster, home, generation: generation.id, ephemeral,
      ephemeralSessionId: () => {
        if (!ephemeral) throw new Error('DeepSeek cannot keep this session ephemeral.');
        return `${DEEPSEEK_EPHEMERAL_PREFIX}${randomUUID()}`;
      },
      fork: (request, ephemeralFork, signal) => {
        if (released) return Promise.reject(new Error('DeepSeek Host lease is released.'));
        if (ephemeralFork && !ephemeral) return Promise.reject(new Error('DeepSeek cannot keep this fork ephemeral.'));
        const run = generation.forks.then(async () => {
          // A fork waiting behind another may outlive its lease or its process; neither may start it.
          if (released) throw new Error('DeepSeek Host lease is released.');
          if (generation.retirement) throw new Error('DeepSeek process ended before the fork started.');
          const withdraw = ephemeralFork ? await process.offerEphemeralFork(request.sessionId, request.atSeq) : undefined;
          let unresolved = false;
          let forked = false;
          let watchdog: number | undefined;
          let expired = false;
          try {
            // Native forks cannot be cancelled, so no client deadline may end one while native continues; only the Host's
            // watchdog does, by ending the process.
            const call = process.client.call('session/fork', { request: { sessionId: request.sessionId, atSeq: request.atSeq } }, { timeoutMs: 'none' });
            call.catch(() => undefined);
            const fork = await Promise.race([call, new Promise<never>((_, reject) => {
              watchdog = window.setTimeout(() => { expired = true; reject(new Error('DeepSeek fork did not finish.')); }, FORK_WATCHDOG_MS);
            })]);
            forked = true;
            if (!isRecord(fork) || typeof fork.sessionId !== 'string') throw new Error('Malformed DeepSeek fork response.');
            return fork.sessionId;
          } catch (error) {
            // Only a native refusal proves no fork exists. Otherwise the unfinished fork may still claim a token, its own
            // after withdrawal or a later fork's, so the process ends first and its token file goes with it. A fork the
            // watchdog gave up on would also complete after Claudian reported it failed, whatever the plugin state.
            unresolved = expired || (ephemeral && !(error instanceof DeepSeekRemoteError && error.code !== undefined));
            if (unresolved) {
              this.lose(generation, 'transport', error instanceof Error ? error : new Error('DeepSeek fork failed.'));
              await this.retire(generation);
            }
            throw error;
          } finally {
            window.clearTimeout(watchdog);
            // A completed fork claimed its token, which can never be claimed again. A refused fork's unclaimed token
            // must not outlive a failed withdrawal, or a later fork of that checkpoint would take it.
            if (!unresolved && withdraw) await withdraw().catch(async () => {
              if (forked) return;
              this.lose(generation, 'transport', new Error('DeepSeek could not withdraw a fork token.'));
              await this.retire(generation);
            });
          }
        });
        generation.forks = run.catch(() => undefined);
        return abortable(run, signal);
      },
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
    const generation: Generation = { id: ++this.generations, abort, lost: new Set(), users: 0, forks: Promise.resolve(), ready: this.boot(abort.signal, () => generation) };
    // A failed startup leaves no generation behind; the next caller starts fresh.
    generation.ready.catch(() => { if (this.current === generation) this.current = undefined; });
    this.current = generation;
    return generation;
  }

  private async boot(signal: AbortSignal, self: () => Generation): Promise<Ready> {
    const options = await this.launch();
    const process = await this.spawn(options, signal);
    if (signal.aborted) { await process.dispose(); throw new Error('DeepSeek startup cancelled.'); }
    const roster = new DeepSeekRoster(process.client, error => this.lose(self(), 'transport', error));
    process.onExit(() => this.lose(self(), 'process-exited', new Error('DeepSeek process exited.')));
    process.client.onDisconnect(() => this.reconnect(self(), process, roster));
    try { await roster.start(); } catch (error) { roster.dispose(); await process.dispose(); throw error; }
    // The plugin reports during native startup; a missing or partial report leaves sessions native.
    const ephemeral = await process.readEphemeralReady().catch(() => false);
    return { process, roster, home: getDeepSeekHome(options.environment), ephemeral };
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
