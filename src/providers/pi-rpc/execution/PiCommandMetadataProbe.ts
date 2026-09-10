import { OwnedProbeRegistry } from '@/core/providers/metadata/OwnedProbeRegistry';
import { ProviderTransitionFence } from '@/core/providers/metadata/ProviderTransitionFence';
import { getRuntimeEnvironmentText } from '@/core/providers/providerEnvironment';
import type { ProviderHost } from '@/core/providers/ProviderHost';
import type { SlashCommand } from '@/core/types';
import { parseEnvironmentVariables } from '@/utils/env';

import type { PiFamilyProfile } from '../PiFamilyProfile';
import { buildPiLaunchSpec } from '../runtime/PiLaunchSpec';
import {
  createPiExecutionKernel,
  type PiExecutionKernel,
  type PiExecutionKernelFactory,
} from './PiExecutionKernel';

type PiCommandMetadataProbeSession = {
  readonly getPushedCommands: () => SlashCommand[] | null;
  readonly kernel: PiExecutionKernel;
};

export class PiCommandMetadataProbe {
  private disposeFlight: Promise<void> | null = null;
  private readonly abortMessage: string;
  private readonly disposedMessage: string;
  private readonly probes: OwnedProbeRegistry<PiCommandMetadataProbeSession>;
  private readonly transitionFence: ProviderTransitionFence;

  constructor(
    private readonly profile: PiFamilyProfile,
    private readonly host: ProviderHost,
    private readonly createKernel: PiExecutionKernelFactory =
      createPiExecutionKernel,
  ) {
    this.abortMessage = `${profile.displayName} command metadata probe aborted`;
    this.disposedMessage =
      `${profile.displayName} command metadata probe is disposed.`;
    this.probes = new OwnedProbeRegistry<PiCommandMetadataProbeSession>({
      abortMessage: this.abortMessage,
      dispose: probe => probe.kernel.shutdown(),
      unavailableError: () => new Error(this.disposedMessage),
    });
    this.transitionFence = new ProviderTransitionFence({
      abortMessage: this.abortMessage,
    });
  }

  async load(
    vaultWorkingDirectory: string,
    signal?: AbortSignal,
  ): Promise<SlashCommand[]> {
    if (this.transitionFence.isUnavailable()) {
      const available = await this.transitionFence.waitUntilAvailable(signal);
      if (!available) throw new Error(this.disposedMessage);
    }

    return await this.probes.run({
      create: async (ownedSignal) => {
        const command = await this.host.getResolvedProviderCliPath(this.profile.providerId)
          ?? this.profile.defaultBinaryName;
        ownedSignal.throwIfAborted();
        const envText = getRuntimeEnvironmentText(
          this.host.settings,
          this.profile.providerId,
        );
        const launchSpec = buildPiLaunchSpec({
          command,
          cwd: vaultWorkingDirectory,
          env: {
            ...process.env,
            ...parseEnvironmentVariables(envText),
          },
          models: this.profile.models,
          noSession: true,
          settings: this.profile.settings.get(this.host.settings),
        });
        let pushedCommands: SlashCommand[] | null = null;
        const kernel = this.createKernel(
          this.profile,
          launchSpec,
          {
            onClose: () => undefined,
            onEvent: (event) => {
              const record = getRecord(event);
              if (record.type !== 'available_commands_update') return;
              pushedCommands = normalizePiRuntimeCommands(
                Array.isArray(record.commands) ? record : record.data,
              );
            },
            onExtensionChunk: () => undefined,
            onExtensionRequest: () => false,
          },
          null,
        );
        return { kernel, getPushedCommands: () => pushedCommands };
      },
      initialize: probe => probe.kernel.start(),
      query: async (probe, ownedSignal) => {
        try {
          const response = await probe.kernel.request<unknown>(
            'get_commands',
            {},
            10_000,
            ownedSignal,
          );
          return normalizePiRuntimeCommands(response);
        } catch (error) {
          const pushedCommands = probe.getPushedCommands();
          if (pushedCommands) return pushedCommands;
          throw error;
        }
      },
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
