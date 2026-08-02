import { OwnedProbeRegistry } from '@/core/providers/metadata/OwnedProbeRegistry';
import { ProviderTransitionFence } from '@/core/providers/metadata/ProviderTransitionFence';
import type { ProviderHost } from '@/core/providers/ProviderHost';
import type { SlashCommand } from '@/core/types';
import { getVaultPath } from '@/utils/path';

import type {
  GrokExecutionNativeConnection,
  GrokExecutionNativeFactory,
} from '../execution/GrokExecutionBackend';
import { GrokExecutionNativeConnectionImpl } from '../execution/GrokExecutionNativeConnection';
import { buildGrokRuntimeEnv } from '../runtime/GrokRuntimeEnvironment';

const DEFAULT_NATIVE_FACTORY: GrokExecutionNativeFactory = {
  create: options => new GrokExecutionNativeConnectionImpl(options),
};

interface GrokCommandProbeResource {
  readonly cwd: string;
  readonly native: GrokExecutionNativeConnection;
}

const ABORT_MESSAGE = 'Grok command metadata probe aborted';
const DISPOSED_MESSAGE = 'Grok command metadata probe is disposed.';

export class GrokCommandMetadataProbe {
  private disposeFlight: Promise<void> | null = null;
  private readonly probes: OwnedProbeRegistry<GrokCommandProbeResource>;
  private readonly transitionFence = new ProviderTransitionFence({
    abortMessage: ABORT_MESSAGE,
  });

  constructor(
    private readonly plugin: ProviderHost,
    private readonly nativeFactory: GrokExecutionNativeFactory = DEFAULT_NATIVE_FACTORY,
  ) {
    this.probes = new OwnedProbeRegistry({
      abortMessage: ABORT_MESSAGE,
      dispose: resource => resource.native.shutdown(),
      unavailableError: () => new Error(DISPOSED_MESSAGE),
    });
  }

  async load(signal?: AbortSignal): Promise<SlashCommand[]> {
    if (this.transitionFence.isUnavailable()) {
      const available = await this.transitionFence.waitUntilAvailable(signal);
      if (!available) throw new Error(DISPOSED_MESSAGE);
    }

    return await this.probes.run({
      create: async (ownedSignal) => {
        const command = await this.plugin.getResolvedProviderCliPath('grok') ?? 'grok';
        ownedSignal.throwIfAborted();
        const cwd = getVaultPath(this.plugin.app) ?? process.cwd();
        return {
          cwd,
          native: this.nativeFactory.create({
            command,
            cwd,
            env: buildGrokRuntimeEnv(this.plugin.settings, command),
            requestExtension: async () => null,
            requestPermission: async () => ({ outcome: { outcome: 'cancelled' } }),
            version: this.plugin.manifest?.version ?? '0.0.0',
          }),
        };
      },
      initialize: resource => resource.native.initialize(),
      query: (resource, ownedSignal) => resource.native.listCommands(
        resource.cwd,
        ownedSignal,
      ),
    }, signal);
  }

  beginEnvironmentTransition(): void {
    this.transitionFence.beginTransition();
  }

  endEnvironmentTransition(): void {
    this.transitionFence.endTransition();
  }

  quiesceForEnvironmentChange(): Promise<void> {
    return this.probes.quiesce();
  }

  dispose(): Promise<void> {
    if (this.disposeFlight) return this.disposeFlight;
    this.transitionFence.dispose();
    this.disposeFlight = (async () => {
      await this.quiesceForEnvironmentChange();
      await this.probes.dispose();
    })();
    return this.disposeFlight;
  }
}
