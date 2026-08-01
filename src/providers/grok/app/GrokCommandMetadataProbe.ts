import type { ProviderHost } from '../../../core/providers/ProviderHost';
import type { SlashCommand } from '../../../core/types';
import { toAbortError } from '../../../utils/abort';
import { getVaultPath } from '../../../utils/path';
import type {
  GrokExecutionNativeConnection,
  GrokExecutionNativeFactory,
} from '../execution/GrokExecutionBackend';
import { GrokExecutionNativeConnectionImpl } from '../execution/GrokExecutionNativeConnection';
import { buildGrokRuntimeEnv } from '../runtime/GrokRuntimeEnvironment';

const DEFAULT_NATIVE_FACTORY: GrokExecutionNativeFactory = {
  create: options => new GrokExecutionNativeConnectionImpl(options),
};

interface ActiveCommandProbe {
  readonly completion: Promise<void>;
  readonly controller: AbortController;
  native: GrokExecutionNativeConnection | null;
  resolveCompletion(): void;
  shutdownFlight: Promise<void> | null;
}

interface TransitionWaiter {
  readonly onAbort?: () => void;
  readonly reject: (error: unknown) => void;
  readonly resolve: () => void;
  readonly signal?: AbortSignal;
}

export class GrokCommandMetadataProbe {
  private readonly activeProbes = new Set<ActiveCommandProbe>();
  private readonly transitionWaiters = new Set<TransitionWaiter>();
  private disposed = false;
  private transitionActive = false;

  constructor(
    private readonly plugin: ProviderHost,
    private readonly nativeFactory: GrokExecutionNativeFactory = DEFAULT_NATIVE_FACTORY,
  ) {}

  load(signal?: AbortSignal): Promise<SlashCommand[]> {
    if (this.disposed) {
      return Promise.reject(new Error('Grok command metadata probe is disposed.'));
    }
    if (signal?.aborted) {
      return Promise.reject(toAbortError(
        signal,
        'Grok command metadata probe aborted',
      ));
    }
    if (this.transitionActive) {
      return this.waitForTransition(signal).then(() => this.load(signal));
    }
    return this.loadUnfenced(signal);
  }

  beginEnvironmentTransition(): void {
    if (!this.disposed) this.transitionActive = true;
  }

  endEnvironmentTransition(): void {
    if (this.disposed) return;
    this.transitionActive = false;
    this.releaseTransitionWaiters();
  }

  private async loadUnfenced(signal?: AbortSignal): Promise<SlashCommand[]> {
    let resolveCompletion!: () => void;
    const entry: ActiveCommandProbe = {
      completion: new Promise(resolve => { resolveCompletion = resolve; }),
      controller: new AbortController(),
      native: null,
      resolveCompletion: () => resolveCompletion(),
      shutdownFlight: null,
    };
    const onAbort = (): void => {
      entry.controller.abort();
      void this.shutdownProbe(entry);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    this.activeProbes.add(entry);
    try {
      entry.controller.signal.throwIfAborted();
      const command = await this.plugin.getResolvedProviderCliPath('grok') ?? 'grok';
      entry.controller.signal.throwIfAborted();
      const cwd = getVaultPath(this.plugin.app) ?? process.cwd();
      entry.native = this.nativeFactory.create({
        command,
        cwd,
        env: buildGrokRuntimeEnv(this.plugin.settings, command),
        requestExtension: async () => null,
        requestPermission: async () => ({ outcome: { outcome: 'cancelled' } }),
        version: this.plugin.manifest?.version ?? '0.0.0',
      });
      await entry.native.initialize();
      entry.controller.signal.throwIfAborted();
      return await entry.native.listCommands(cwd, entry.controller.signal);
    } finally {
      signal?.removeEventListener('abort', onAbort);
      await this.shutdownProbe(entry);
      this.activeProbes.delete(entry);
      entry.resolveCompletion();
    }
  }

  async quiesceForEnvironmentChange(): Promise<void> {
    const active = [...this.activeProbes];
    for (const entry of active) entry.controller.abort();
    await Promise.all(active.map(entry => this.shutdownProbe(entry)));
    await Promise.all(active.map(entry => entry.completion));
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.rejectTransitionWaiters(new Error('Grok command metadata probe is disposed.'));
    await this.quiesceForEnvironmentChange();
  }

  private waitForTransition(signal?: AbortSignal): Promise<void> {
    if (this.disposed) {
      return Promise.reject(new Error('Grok command metadata probe is disposed.'));
    }
    if (!this.transitionActive) return Promise.resolve();
    if (signal?.aborted) {
      return Promise.reject(toAbortError(
        signal,
        'Grok command metadata probe aborted',
      ));
    }

    return new Promise<void>((resolve, reject) => {
      const onAbort = (): void => {
        if (!this.transitionWaiters.delete(waiter)) return;
        reject(toAbortError(signal!, 'Grok command metadata probe aborted'));
      };
      const waiter: TransitionWaiter = {
        reject,
        resolve,
        ...(signal ? { onAbort, signal } : {}),
      };
      this.transitionWaiters.add(waiter);
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) onAbort();
    });
  }

  private releaseTransitionWaiters(): void {
    const waiters = [...this.transitionWaiters];
    this.transitionWaiters.clear();
    for (const waiter of waiters) {
      this.removeWaiterAbortListener(waiter);
      waiter.resolve();
    }
  }

  private rejectTransitionWaiters(error: unknown): void {
    const waiters = [...this.transitionWaiters];
    this.transitionWaiters.clear();
    for (const waiter of waiters) {
      this.removeWaiterAbortListener(waiter);
      waiter.reject(error);
    }
  }

  private removeWaiterAbortListener(waiter: TransitionWaiter): void {
    if (waiter.signal && waiter.onAbort) {
      waiter.signal.removeEventListener('abort', waiter.onAbort);
    }
  }

  private shutdownProbe(entry: ActiveCommandProbe): Promise<void> {
    if (entry.shutdownFlight) return entry.shutdownFlight;
    const native = entry.native;
    if (!native) return Promise.resolve();
    entry.native = null;
    entry.shutdownFlight = native.shutdown().catch(() => undefined);
    return entry.shutdownFlight;
  }
}
