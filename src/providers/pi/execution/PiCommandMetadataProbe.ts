import { OwnedProbeRegistry } from '@/core/providers/metadata/OwnedProbeRegistry';
import { ProviderTransitionFence } from '@/core/providers/metadata/ProviderTransitionFence';
import { getRuntimeEnvironmentText } from '@/core/providers/providerEnvironment';
import type { ProviderHost } from '@/core/providers/ProviderHost';
import type { SlashCommand } from '@/core/types';
import { parseEnvironmentVariables } from '@/utils/env';

import { buildPiLaunchSpec } from '../runtime/PiLaunchSpec';
import { getPiProviderSettings } from '../settings';
import {
  createPiExecutionKernel,
  type PiExecutionKernel,
  type PiExecutionKernelFactory,
} from './PiExecutionKernel';

const ABORT_MESSAGE = 'Pi command metadata probe aborted';
const DISPOSED_MESSAGE = 'Pi command metadata probe is disposed.';

type PiCommandMetadataProbeSession = {
  readonly getPushedCommands: () => SlashCommand[] | null;
  readonly kernel: PiExecutionKernel;
};

export class PiCommandMetadataProbe {
  private disposeFlight: Promise<void> | null = null;
  private readonly probes: OwnedProbeRegistry<PiCommandMetadataProbeSession>;
  private readonly transitionFence = new ProviderTransitionFence({
    abortMessage: ABORT_MESSAGE,
  });

  constructor(
    private readonly host: ProviderHost,
    private readonly createKernel: PiExecutionKernelFactory =
      createPiExecutionKernel,
  ) {
    this.probes = new OwnedProbeRegistry<PiCommandMetadataProbeSession>({
      abortMessage: ABORT_MESSAGE,
      dispose: probe => probe.kernel.shutdown(),
      unavailableError: () => new Error(DISPOSED_MESSAGE),
    });
  }

  async load(
    vaultWorkingDirectory: string,
    signal?: AbortSignal,
  ): Promise<SlashCommand[]> {
    if (this.transitionFence.isUnavailable()) {
      const available = await this.transitionFence.waitUntilAvailable(signal);
      if (!available) throw new Error(DISPOSED_MESSAGE);
    }

    return await this.probes.run({
      create: async (ownedSignal) => {
        const command = await this.host.getResolvedProviderCliPath('pi') ?? 'pi';
        ownedSignal.throwIfAborted();
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
        let pushedCommands: SlashCommand[] | null = null;
        const kernel = this.createKernel(
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
