import { randomUUID } from 'node:crypto';

import type { ProviderInteractionPort } from '@/core/execution';
import { OwnedProbeRegistry } from '@/core/providers/metadata/OwnedProbeRegistry';
import { ProviderTransitionFence } from '@/core/providers/metadata/ProviderTransitionFence';
import type { ProviderHost } from '@/core/providers/ProviderHost';
import type { SlashCommand } from '@/core/types';
import { ACPSessionUpdateNormalizer } from '@/providers/acp';

import type { OpencodeCommandCatalog } from '../commands/OpencodeCommandCatalog';
import {
  DefaultOpencodeACPSessionKernel,
  type OpencodeACPSessionKernel,
  type OpencodeNativeSessionInfo,
} from '../execution/OpencodeACPSessionKernel';
import { OpencodeServerService } from '../http/OpencodeServerService';
import { decodeOpencodeModelId } from '../models';
import { buildOpencodeRuntimeEnv } from '../runtime/OpencodeRuntimeEnvironment';
import { detectOpencodeNativeVersion } from '../runtime/OpencodeVersion';
import {
  type OpencodeMetadataProjectionInput,
  projectOpencodeMetadata,
} from './OpencodeMetadataProjection';
import { OpencodeV2MetadataProbe } from './OpencodeV2MetadataProbe';

export interface OpencodeMetadataCatalogResult
  extends OpencodeMetadataProjectionInput {
  readonly commands: readonly SlashCommand[] | null;
}

export interface OpencodeMetadataWarmResult
  extends OpencodeMetadataProjectionInput {
  readonly rawModelId: string;
}

export interface OpencodeMetadataProbe {
  dispose(): Promise<void>;
  loadCatalog(signal?: AbortSignal): Promise<OpencodeMetadataCatalogResult>;
  warmModel(
    rawModelId: string,
    signal?: AbortSignal,
  ): Promise<OpencodeMetadataWarmResult>;
}

export interface OpencodeMetadataServiceOptions {
  readonly commandCatalog?: Pick<OpencodeCommandCatalog, 'setCommandSnapshot'>;
  readonly serverService?: OpencodeServerService;
  readonly createProbe?: () => OpencodeMetadataProbe;
}

export class OpencodeMetadataService {
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
        const version = await detectOpencodeNativeVersion(cliPath, environment);
        signal.throwIfAborted();
        if (version !== 2) return new DefaultOpencodeMetadataProbe(plugin);
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
    const result = await this.#runProbe(
      async (probe, ownedSignal) => {
        const catalog = await probe.loadCatalog(ownedSignal);
        ownedSignal.throwIfAborted();
        await projectOpencodeMetadata(this.plugin, catalog, ownedSignal);
        ownedSignal.throwIfAborted();
        if (catalog.commands !== null) {
          this.options.commandCatalog?.setCommandSnapshot(
            catalog.commands.map((command) => ({ ...command })),
          );
        }
        return true;
      },
      signal,
    );
    return result ?? false;
  }

  async loadCommands(signal?: AbortSignal): Promise<SlashCommand[]> {
    const result = await this.discoverCommands(signal);
    return result.commands;
  }

  async discoverCommands(
    signal?: AbortSignal,
  ): Promise<{ commands: SlashCommand[]; loaded: boolean }> {
    const result = await this.#runProbe(
      async (probe, ownedSignal) => {
        const catalog = await probe.loadCatalog(ownedSignal);
        ownedSignal.throwIfAborted();
        if (catalog.commands === null) {
          return { commands: [], loaded: false };
        }
        const commands = catalog.commands.map((command) => ({ ...command }));
        this.options.commandCatalog?.setCommandSnapshot(commands);
        return { commands, loaded: true };
      },
      signal,
    );
    if (!result) return { commands: [], loaded: false };
    return result;
  }

  async warmModelMetadata(
    model: string,
    signal?: AbortSignal,
  ): Promise<boolean> {
    const rawModelId = decodeOpencodeModelId(model);
    if (!rawModelId) return false;
    const result = await this.#runProbe(
      async (probe, ownedSignal) => {
        const metadata = await probe.warmModel(rawModelId, ownedSignal);
        ownedSignal.throwIfAborted();
        await projectOpencodeMetadata(this.plugin, {
          ...metadata,
          selectedRawModelId: metadata.rawModelId,
          reasoningMetadataResolved: true,
        }, ownedSignal);
        ownedSignal.throwIfAborted();
        return true;
      },
      signal,
    );
    return result ?? false;
  }

  async invalidate(): Promise<void> {
    this.transitionFence.beginTransition();
    try {
      this.options.commandCatalog?.setCommandSnapshot([]);
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
  ): Promise<T | null> {
    try {
      if (this.disposed) return null;
      if (this.transitionFence.isUnavailable()) {
        const available = await this.transitionFence.waitUntilAvailable(signal);
        if (!available) return null;
      }
      return await this.probes.run({
        create: signal => this.createProbe(signal),
        query: operation,
      }, signal);
    } catch {
      return null;
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

class DefaultOpencodeMetadataProbe implements OpencodeMetadataProbe {
  private readonly normalizer = new ACPSessionUpdateNormalizer();
  private commands: SlashCommand[] | null = null;
  private kernel: OpencodeACPSessionKernel | null = null;
  private native: OpencodeNativeSessionInfo | null = null;
  private commandWaiter: (() => void) | null = null;

  constructor(private readonly plugin: ProviderHost) {}

  async loadCatalog(signal?: AbortSignal): Promise<OpencodeMetadataCatalogResult> {
    const native = await this.#ensureOpen(signal);
    if (!this.commands) {
      await waitForCommands(
        () => this.commands !== null,
        (resolve) => {
          this.commandWaiter = resolve;
          return () => {
            if (this.commandWaiter === resolve) this.commandWaiter = null;
          };
        },
        signal,
      );
    }
    return {
      commands: this.commands,
      configOptions: native.configOptions,
      models: native.models,
      modes: native.modes,
    };
  }

  async warmModel(
    rawModelId: string,
    signal?: AbortSignal,
  ): Promise<OpencodeMetadataWarmResult> {
    const native = await this.#ensureOpen(signal);
    signal?.throwIfAborted();
    const response = await this.#requireKernel().setConfigOption({
      configId: 'model',
      sessionId: native.sessionId,
      type: 'select',
      value: rawModelId,
    });
    signal?.throwIfAborted();
    return {
      configOptions: response.configOptions,
      models: native.models,
      modes: native.modes,
      rawModelId,
    };
  }

  async dispose(): Promise<void> {
    const kernel = this.kernel;
    this.kernel = null;
    this.native = null;
    this.commandWaiter?.();
    this.commandWaiter = null;
    await kernel?.dispose();
  }

  async #ensureOpen(
    signal?: AbortSignal,
  ): Promise<OpencodeNativeSessionInfo> {
    signal?.throwIfAborted();
    if (this.native) return this.native;
    const kernel = new DefaultOpencodeACPSessionKernel({
      config: {
        interactionPort: DENY_INTERACTION_PORT,
        lifecycle: 'ephemeral',
        nativePersistence: 'disabled-if-supported',
        vaultWorkingDirectory: resolveVaultPath(this.plugin),
      },
      databasePath: ':memory:',
      getActiveTurnId: () => null,
      onClosed: () => undefined,
      onNotification: (notification) => {
        let normalized;
        try {
          normalized = this.normalizer.normalize(notification.update);
        } catch {
          return;
        }
        if (normalized.type !== 'commands') return;
        this.commands = normalized.commands.map((command) => ({ ...command }));
        this.commandWaiter?.();
      },
      plugin: this.plugin,
      sessionInstanceId: `metadata-${randomUUID()}`,
    });
    this.kernel = kernel;
    await kernel.connect({
      profile: 'passive',
      systemInstructions: { kind: 'provider-default' },
    });
    signal?.throwIfAborted();
    this.native = await kernel.openSession();
    signal?.throwIfAborted();
    return this.native;
  }

  #requireKernel(): OpencodeACPSessionKernel {
    if (!this.kernel) throw new Error('OpenCode metadata probe is not connected');
    return this.kernel;
  }
}

const DENY_INTERACTION_PORT: ProviderInteractionPort = {
  askUserQuestion: async ({ interactionId }) => ({
    answers: null,
    interactionId,
  }),
  dismissInteraction: () => undefined,
  requestApproval: async ({ interactionId }) => ({
    decision: 'deny',
    interactionId,
  }),
};

function resolveVaultPath(plugin: ProviderHost): string {
  const adapter = plugin.app.vault.adapter as { basePath?: unknown };
  return typeof adapter.basePath === 'string' && adapter.basePath
    ? adapter.basePath
    : process.cwd();
}

function waitForCommands(
  isReady: () => boolean,
  subscribe: (resolve: () => void) => () => void,
  signal?: AbortSignal,
): Promise<void> {
  if (isReady()) return Promise.resolve();
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeout);
      unsubscribe();
      signal?.removeEventListener('abort', onAbort);
      if (error) reject(error);
      else resolve();
    };
    const unsubscribe = subscribe(() => finish());
    const timeout = window.setTimeout(() => finish(), 5_000);
    const onAbort = () => finish(new Error('OpenCode metadata probe aborted'));
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}
