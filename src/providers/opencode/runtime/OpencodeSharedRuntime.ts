import type { ProviderRuntimeHost } from '@/core/providers/ProviderRuntimeHost';

import { decodeOpencodeConfig } from '../config';
import type { OpencodeServerService } from '../http/OpencodeServerService';
import { resolveOpencodeTarget } from './OpencodeExecutionTarget';
import { OpencodeCLINotInstalledError } from './OpencodeVersion';

type PrewarmState =
  | { phase: 'idle' }
  | { phase: 'starting'; startup: Promise<void> }
  /** Prewarm was requested and is not in flight; transitions prewarm again. */
  | { phase: 'requested' }
  /** `requested` still decides whether a late transition calls the inert start(). */
  | { phase: 'disposed'; requested: boolean };

/** Provider-owned prewarm and launch transitions for the shared server. */
export class OpencodeSharedRuntime {
  private state: PrewarmState = { phase: 'idle' };
  // Replaced by every transition, independently of the prewarm lifecycle.
  private controller = new AbortController();

  constructor(
    private readonly host: ProviderRuntimeHost,
    private readonly serverService: OpencodeServerService,
  ) {}

  /** Prewarms the committed launch without creating a native session. */
  start(): Promise<void> {
    if (this.state.phase === 'disposed') {
      this.state.requested = true;
      return Promise.resolve();
    }
    if (this.state.phase === 'starting') return this.state.startup;
    const pending = this.#start();
    this.state = { phase: 'starting', startup: pending };
    void pending.finally(() => {
      if (this.state.phase === 'starting' && this.state.startup === pending) this.state = { phase: 'requested' };
    }).catch(() => undefined);
    return pending;
  }

  beginTransition(): void {
    this.controller.abort();
    this.controller = new AbortController();
    this.serverService.beginTransition();
  }

  async endTransition(): Promise<void> {
    try {
      if (!decodeOpencodeConfig(this.host.config).enabled) await this.serverService.invalidate();
      else {
        const launch = await this.#resolveLaunch();
        this.serverService.reconcileLaunch(launch.cliPath, launch.cwd, launch.environment, launch.target);
      }
    } finally { this.serverService.endTransition(); }
    if (this.#isRequested()) await this.start().catch(() => undefined);
  }

  dispose(): void {
    if (this.state.phase !== 'disposed') this.state = { phase: 'disposed', requested: this.state.phase !== 'idle' };
    this.controller.abort();
  }

  #isRequested(): boolean {
    return this.state.phase === 'disposed' ? this.state.requested : this.state.phase !== 'idle';
  }

  #isDisposed(): boolean {
    return this.state.phase === 'disposed';
  }

  async #start(): Promise<void> {
    for (;;) {
      // Read settings only once admission is open, so a transition cannot leak a stale launch.
      await this.serverService.waitUntilAvailable();
      if (this.#isDisposed() || !decodeOpencodeConfig(this.host.config).enabled) return;
      const signal = this.controller.signal;
      try {
        const launch = await this.#resolveLaunch();
        signal.throwIfAborted();
        this.serverService.reconcileLaunch(launch.cliPath, launch.cwd, launch.environment, launch.target);
        const lease = await this.serverService.acquire(launch.cliPath, launch.cwd, launch.environment, signal, launch.target);
        try { await lease.request('/api/info', { signal }); }
        finally { await lease.dispose(); }
        return;
      } catch (error) {
        // A missing CLI has nothing to prewarm; an unsupported one rejects.
        if (error instanceof OpencodeCLINotInstalledError) return;
        // A transition overtook this attempt; retry against its committed settings.
        if (this.#isDisposed() || !signal.aborted) throw error;
      }
    }
  }

  async #resolveLaunch() {
    const cliPath = await this.host.resolveCliPath() ?? 'opencode';
    const cwd = this.host.workingDirectory || process.cwd();
    const target = await resolveOpencodeTarget(this.host.config, cwd);
    const environment = await this.serverService.targetEnvironment.resolve(target, cwd, this.host.environmentText, cliPath);
    return { cliPath, cwd, target, environment };
  }
}
