import { getRuntimeEnvironmentText } from '../../../core/providers/providerEnvironment';
import type { ProviderHost } from '../../../core/providers/ProviderHost';
import type { SlashCommand } from '../../../core/types';
import { toAbortError } from '../../../utils/abort';
import { parseEnvironmentVariables } from '../../../utils/env';
import { buildPiLaunchSpec } from '../runtime/PiLaunchSpec';
import { getPiProviderSettings } from '../settings';
import {
  createPiExecutionKernel,
  type PiExecutionKernel,
  type PiExecutionKernelFactory,
} from './PiExecutionKernel';

interface ActiveCommandProbe {
  readonly completion: Promise<void>;
  readonly controller: AbortController;
  kernel: PiExecutionKernel | null;
  resolveCompletion(): void;
  shutdownFlight: Promise<void> | null;
}

interface TransitionWaiter {
  readonly onAbort?: () => void;
  readonly reject: (error: unknown) => void;
  readonly resolve: () => void;
  readonly signal?: AbortSignal;
}

export class PiCommandMetadataProbe {
  private readonly activeProbes = new Set<ActiveCommandProbe>();
  private readonly transitionWaiters = new Set<TransitionWaiter>();
  private disposed = false;
  private transitionActive = false;

  constructor(
    private readonly host: ProviderHost,
    private readonly createKernel: PiExecutionKernelFactory =
      createPiExecutionKernel,
  ) {}

  load(
    vaultWorkingDirectory: string,
    signal?: AbortSignal,
  ): Promise<SlashCommand[]> {
    if (this.disposed) {
      return Promise.reject(new Error('Pi command metadata probe is disposed.'));
    }
    if (signal?.aborted) {
      return Promise.reject(toAbortError(
        signal,
        'Pi command metadata probe aborted',
      ));
    }
    if (this.transitionActive) {
      return this.waitForTransition(signal).then(() =>
        this.load(vaultWorkingDirectory, signal));
    }
    return this.loadUnfenced(vaultWorkingDirectory, signal);
  }

  beginEnvironmentTransition(): void {
    if (!this.disposed) this.transitionActive = true;
  }

  endEnvironmentTransition(): void {
    if (this.disposed) return;
    this.transitionActive = false;
    this.releaseTransitionWaiters();
  }

  private async loadUnfenced(
    vaultWorkingDirectory: string,
    signal?: AbortSignal,
  ): Promise<SlashCommand[]> {
    let resolveCompletion!: () => void;
    const entry: ActiveCommandProbe = {
      completion: new Promise(resolve => { resolveCompletion = resolve; }),
      controller: new AbortController(),
      kernel: null,
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
      const command = await this.host.getResolvedProviderCliPath('pi') ?? 'pi';
      entry.controller.signal.throwIfAborted();
      const envText = getRuntimeEnvironmentText(this.host.settings, 'pi');
      const launchSpec = buildPiLaunchSpec({
        command,
        cwd: vaultWorkingDirectory,
        env: {
          ...process.env,
          ...parseEnvironmentVariables(envText),
        },
        envText,
        noSession: true,
        settings: getPiProviderSettings(this.host.settings),
      });
      const kernel = this.createKernel(
        launchSpec,
        {
          onClose: () => undefined,
          onEvent: () => undefined,
          onExtensionChunk: () => undefined,
          onExtensionRequest: () => undefined,
        },
        null,
      );
      entry.kernel = kernel;
      entry.controller.signal.throwIfAborted();
      kernel.start();
      entry.controller.signal.throwIfAborted();
      const response = await kernel.request<unknown>(
        'get_commands',
        {},
        10_000,
        entry.controller.signal,
      );
      entry.controller.signal.throwIfAborted();
      return normalizePiRuntimeCommands(response);
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
    this.rejectTransitionWaiters(new Error('Pi command metadata probe is disposed.'));
    await this.quiesceForEnvironmentChange();
  }

  private waitForTransition(signal?: AbortSignal): Promise<void> {
    if (this.disposed) {
      return Promise.reject(new Error('Pi command metadata probe is disposed.'));
    }
    if (!this.transitionActive) return Promise.resolve();
    if (signal?.aborted) {
      return Promise.reject(toAbortError(
        signal,
        'Pi command metadata probe aborted',
      ));
    }

    return new Promise<void>((resolve, reject) => {
      const onAbort = (): void => {
        if (!this.transitionWaiters.delete(waiter)) return;
        reject(toAbortError(signal!, 'Pi command metadata probe aborted'));
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
    const kernel = entry.kernel;
    if (!kernel) return Promise.resolve();
    entry.kernel = null;
    entry.shutdownFlight = kernel.shutdown().catch(() => undefined);
    return entry.shutdownFlight;
  }
}

export function normalizePiRuntimeCommands(response: unknown): SlashCommand[] {
  const record = getRecord(response);
  const entries = Array.isArray(response)
    ? response
    : Array.isArray(record.commands)
      ? record.commands
      : [];
  const commands: SlashCommand[] = [];
  const seen = new Set<string>();
  for (const value of entries) {
    const entry = getRecord(value);
    const name = getString(entry.name);
    if (!name || seen.has(name)) continue;
    seen.add(name);
    const source = getString(entry.source);
    commands.push({
      content: '',
      description: getString(entry.description) ?? undefined,
      id: `pi:${source ?? 'runtime'}:${name}`,
      kind: source === 'skill' ? 'skill' : 'command',
      name,
      source: 'sdk',
    });
  }
  return commands;
}

function getRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function getString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}
