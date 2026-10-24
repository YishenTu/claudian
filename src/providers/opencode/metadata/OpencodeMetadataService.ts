import { OwnedProbeRegistry } from '@/core/providers/metadata/OwnedProbeRegistry';
import { ProviderTransitionFence } from '@/core/providers/metadata/ProviderTransitionFence';
import type { ProviderHost } from '@/core/providers/ProviderHost';
import type { ProviderModelCatalogRefreshResult } from '@/core/providers/types';
import type { SlashCommand } from '@/core/types';
import { toAbortError } from '@/utils/abort';
import { toError } from '@/utils/error';

import type { OpencodeNativeModel } from '../http/OpencodeNativeModelCatalog';
import { OpencodeServerService } from '../http/OpencodeServerService';
import { decodeOpencodeModelId } from '../models';
import { buildOpencodeRuntimeEnv } from '../runtime/OpencodeRuntimeEnvironment';
import { getOpencodeProviderSettings } from '../settings';
import { projectOpencodeMetadata } from './OpencodeMetadataProjection';
import { OpencodeV2MetadataProbe } from './OpencodeV2MetadataProbe';

export interface OpencodeMetadataCatalogResult {
  readonly models: readonly OpencodeNativeModel[];
}

export interface OpencodeMetadataWarmResult extends OpencodeMetadataCatalogResult {
  readonly rawModelId: string;
  readonly thinkingLevels: readonly string[];
}

export interface OpencodeMetadataProbe {
  dispose(): Promise<void>;
  loadCatalog(signal?: AbortSignal): Promise<OpencodeMetadataCatalogResult>;
  loadCommands(signal?: AbortSignal): Promise<SlashCommand[]>;
  warmModel(
    rawModelId: string,
    signal?: AbortSignal,
  ): Promise<OpencodeMetadataWarmResult>;
}

export interface OpencodeMetadataServiceOptions {
  readonly serverService?: OpencodeServerService;
  readonly createProbe?: () => OpencodeMetadataProbe;
}

type CommandResult = { commands: SlashCommand[]; loaded: boolean };
interface CommandFlight { promise: Promise<CommandResult>; controller: AbortController; consumers: number }

export class OpencodeMetadataService {
  private commandFlight: CommandFlight | null = null;
  private readonly createProbe: (signal: AbortSignal) => OpencodeMetadataProbe | Promise<OpencodeMetadataProbe>;
  private readonly probes: OwnedProbeRegistry<OpencodeMetadataProbe>;
  private readonly transitionFence = new ProviderTransitionFence({
    abortMessage: 'OpenCode metadata probe aborted',
  });
  private readonly unregisterTransitionHook: () => void;
  private readonly serverService: OpencodeServerService;
  private disposed = false;
  private disposeFlight: Promise<void> | null = null;

  constructor(
    private readonly plugin: ProviderHost,
    private readonly options: OpencodeMetadataServiceOptions = {},
  ) {
    this.serverService = options.serverService ?? new OpencodeServerService();
    this.createProbe = options.createProbe
      ?? (async (signal) => {
        const cliPath = await plugin.getResolvedProviderCliPath('opencode') ?? 'opencode';
        const environment = buildOpencodeRuntimeEnv(plugin.settings, cliPath);
        return new OpencodeV2MetadataProbe(await this.serverService.acquire(cliPath, resolveVaultPath(plugin), environment, signal));
      });
    this.probes = new OwnedProbeRegistry({
      abortMessage: 'OpenCode metadata probe aborted',
      dispose: probe => probe.dispose(),
      unavailableError: () => new Error('OpenCode metadata service is disposed.'),
    });
    this.unregisterTransitionHook = plugin.executionLifecycleRegistry
      .registerTransitionHook('opencode', {
        beforeTransition: () => {
          this.beginTransition();
          return this.invalidate();
        },
        afterTransition: () => this.#completeTransition(),
      });
  }

  async loadCatalog(signal?: AbortSignal): Promise<boolean> {
    return await this.#runProbe((probe, ownedSignal) => this.#publishCatalog(probe, ownedSignal), signal) ?? false;
  }

  async discoverModels(signal?: AbortSignal): Promise<ProviderModelCatalogRefreshResult> {
    return await this.#runProbe<ProviderModelCatalogRefreshResult>(async (probe, ownedSignal) => {
      await this.#publishCatalog(probe, ownedSignal);
      const selected = getOpencodeProviderSettings(this.plugin.settings).visibleModels;
      for (const id of selected) {
        ownedSignal.throwIfAborted();
        const current = getOpencodeProviderSettings(this.plugin.settings);
        if (!current.visibleModels.includes(id) || Object.hasOwn(current.thinkingOptionsByModel, id)) continue;
        await this.#warmModel(probe, id, ownedSignal);
      }
      return { changed: true };
    }, signal, error => ({
      changed: false,
      diagnostics: `Could not load OpenCode models: ${toError(error, 'Model discovery failed.').message} Check the CLI path and login, the vault's .opencode/opencode.json, and OpenCode logs (run opencode debug paths to locate them), then click Discover.`,
    })) ?? { changed: false };
  }

  async #publishCatalog(probe: OpencodeMetadataProbe, signal: AbortSignal): Promise<boolean> {
    const catalog = await probe.loadCatalog(signal);
    signal.throwIfAborted();
    await projectOpencodeMetadata(this.plugin, catalog, signal);
    signal.throwIfAborted();
    return true;
  }

  async discoverCommands(
    signal?: AbortSignal,
  ): Promise<{ commands: SlashCommand[]; loaded: boolean }> {
    do {
      if (!await this.transitionFence.waitUntilAvailable(signal)) return { commands: [], loaded: false };
    } while (this.transitionFence.isUnavailable());
    signal?.throwIfAborted();
    let flight = this.commandFlight;
    if (!flight) {
      const controller = new AbortController();
      const promise = this.#runProbe(async (probe, ownedSignal) => {
        const commands = await probe.loadCommands(ownedSignal);
        ownedSignal.throwIfAborted();
        return { commands: commands.map(command => ({ ...command })), loaded: true };
      }, controller.signal).then(result => result ?? { commands: [], loaded: false });
      flight = { promise, controller, consumers: 0 };
      this.commandFlight = flight;
      const owned = flight;
      void promise.finally(() => {
        if (this.commandFlight === owned) this.commandFlight = null;
      }).catch(() => undefined);
    }
    flight.consumers += 1;
    try {
      return await new Promise<CommandResult>((resolve, reject) => {
        const onAbort = () => reject(toAbortError(signal!, 'OpenCode command discovery aborted.'));
        signal?.addEventListener('abort', onAbort, { once: true });
        flight.promise.then(result => {
          signal?.removeEventListener('abort', onAbort);
          if (signal?.aborted) onAbort();
          else resolve({ ...result, commands: result.commands.map(command => ({ ...command })) });
        }, error => {
          signal?.removeEventListener('abort', onAbort);
          reject(toError(error, 'OpenCode command discovery failed.'));
        });
        if (signal?.aborted) onAbort();
      });
    } finally {
      if (--flight.consumers === 0) {
        flight.controller.abort();
        if (this.commandFlight === flight) this.commandFlight = null;
      }
    }
  }

  async warmModelMetadata(model: string, signal?: AbortSignal): Promise<boolean> {
    return this.warmModelsMetadata([model], signal);
  }

  async warmModelsMetadata(models: readonly string[], signal?: AbortSignal): Promise<boolean> {
    const ids = models.map(decodeOpencodeModelId).filter((id): id is string => !!id);
    if (ids.length === 0) return false;
    return await this.#runProbe(async (probe, ownedSignal) => {
      let warmed = false;
      for (const id of ids) {
        ownedSignal.throwIfAborted();
        warmed = await this.#warmModel(probe, id, ownedSignal) || warmed;
      }
      return warmed;
    }, signal) ?? false;
  }

  async #warmModel(probe: OpencodeMetadataProbe, rawModelId: string, signal: AbortSignal): Promise<boolean> {
    try {
      const metadata = await probe.warmModel(rawModelId, signal);
      signal.throwIfAborted();
      await projectOpencodeMetadata(this.plugin, {
        models: metadata.models,
        selectedRawModelId: metadata.rawModelId,
        thinkingLevels: metadata.thinkingLevels,
      }, signal);
      signal.throwIfAborted();
      return true;
    } catch {
      signal.throwIfAborted();
      return false;
    }
  }

  async invalidate(): Promise<void> {
    this.transitionFence.beginTransition();
    try {
      this.commandFlight?.controller.abort();
      this.commandFlight = null;
      await Promise.all([this.probes.quiesce(), this.options.serverService ? undefined : this.serverService.invalidate()]);
    } finally {
      this.transitionFence.endTransition();
    }
  }

  dispose(): Promise<void> {
    if (this.disposeFlight) return this.disposeFlight;
    this.disposed = true;
    this.transitionFence.dispose();
    this.unregisterTransitionHook();
    this.disposeFlight = (async () => {
      await this.invalidate();
      await this.probes.dispose();
      if (!this.options.serverService) await this.serverService.dispose();
    })();
    return this.disposeFlight;
  }

  async #runProbe<T>(
    operation: (probe: OpencodeMetadataProbe, signal: AbortSignal) => Promise<T>,
    signal?: AbortSignal,
    onError?: (error: unknown) => T,
  ): Promise<T | null> {
    let probeSignal: AbortSignal | undefined;
    try {
      if (this.disposed) return null;
      if (this.transitionFence.isUnavailable()) {
        const available = await this.transitionFence.waitUntilAvailable(signal);
        if (!available) return null;
      }
      return await this.probes.run({
        create: signal => {
          probeSignal = signal;
          return this.createProbe(signal);
        },
        query: operation,
      }, signal);
    } catch (error) {
      if (signal?.aborted || probeSignal?.aborted) return null;
      return onError?.(error) ?? null;
    }
  }

  private beginTransition(): void {
    this.transitionFence.beginTransition();
  }

  async #completeTransition(): Promise<void> {
    try {
      await this.invalidate();
    } finally {
      this.transitionFence.endTransition();
    }
  }
}

function resolveVaultPath(plugin: ProviderHost): string {
  const adapter = plugin.app.vault.adapter as { basePath?: unknown };
  return typeof adapter.basePath === 'string' && adapter.basePath
    ? adapter.basePath
    : process.cwd();
}
