import type { ProviderHost } from '@/core/providers/ProviderHost';

import type { OpencodeServerService } from '../http/OpencodeServerService';
import { getOpencodeProviderSettings } from '../settings';
import { buildOpencodeRuntimeEnv } from './OpencodeRuntimeEnvironment';
import { detectOpencodeNativeVersion, type OpencodeNativeVersion } from './OpencodeVersion';

/** Provider-owned prewarm and launch transitions for the shared v2 server. */
export class OpencodeSharedRuntime {
  private requested = false;
  private disposed = false;
  private generation = 0;
  private controller = new AbortController();
  private startup: Promise<void> | null = null;

  constructor(
    private readonly plugin: ProviderHost,
    private readonly serverService: OpencodeServerService,
    private readonly onNativeVersion: (version: OpencodeNativeVersion | undefined) => void,
  ) {}

  /** Prewarms the committed launch without creating a native session. */
  start(): Promise<void> {
    this.requested = true;
    if (this.disposed) return Promise.resolve();
    if (this.startup) return this.startup;
    const pending = this.#start();
    this.startup = pending;
    void pending.finally(() => { if (this.startup === pending) this.startup = null; }).catch(() => undefined);
    return pending;
  }

  beginTransition(): void {
    this.generation += 1;
    this.controller.abort();
    this.controller = new AbortController();
    this.serverService.beginTransition();
  }

  async endTransition(): Promise<void> {
    try {
      if (!getOpencodeProviderSettings(this.plugin.settings).enabled) await this.serverService.invalidate();
      else {
        const launch = await this.#resolveLaunch();
        this.serverService.reconcileLaunch(launch.cliPath, launch.cwd, launch.environment);
      }
    } finally { this.serverService.endTransition(); }
    if (this.requested) await this.start().catch(() => undefined);
  }

  dispose(): void {
    this.disposed = true;
    this.generation += 1;
    this.controller.abort();
  }

  async #start(): Promise<void> {
    for (;;) {
      // Read settings only once admission is open, so a transition cannot leak a stale launch.
      await this.serverService.waitUntilAvailable();
      if (this.disposed || !getOpencodeProviderSettings(this.plugin.settings).enabled) return;
      const generation = this.generation;
      const signal = this.controller.signal;
      try {
        const launch = await this.#resolveLaunch();
        signal.throwIfAborted();
        const version = await detectOpencodeNativeVersion(launch.cliPath, launch.environment);
        signal.throwIfAborted();
        this.onNativeVersion(version);
        if (version !== 2) return;
        this.serverService.reconcileLaunch(launch.cliPath, launch.cwd, launch.environment);
        const lease = await this.serverService.acquire(launch.cliPath, launch.cwd, launch.environment, signal);
        try { await lease.request('/api/info', { signal }); }
        finally { await lease.dispose(); }
        return;
      } catch (error) {
        // A transition overtook this attempt; retry against its committed settings.
        if (this.disposed || generation === this.generation) throw error;
      }
    }
  }

  async #resolveLaunch() {
    const cliPath = await this.plugin.getResolvedProviderCliPath('opencode') ?? 'opencode';
    const adapter = this.plugin.app.vault.adapter as { basePath?: string };
    return { cliPath, cwd: adapter.basePath || process.cwd(), environment: buildOpencodeRuntimeEnv(this.plugin.settings, cliPath) };
  }
}
