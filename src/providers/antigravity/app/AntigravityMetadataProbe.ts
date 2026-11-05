import { OwnedProbeRegistry } from '@/core/providers/metadata/OwnedProbeRegistry';
import { ProviderTransitionFence } from '@/core/providers/metadata/ProviderTransitionFence';
import type { ProviderRuntimeHost } from '@/core/providers/ProviderRuntimeHost';
import type { SlashCommand } from '@/core/types';
import { type ACPSessionNotification, normalizeACPAvailableCommands } from '@/providers/acp';

import { ANTIGRAVITY_ACP_ARGS, AntigravityNativeConnection } from '../execution/AntigravityNativeConnection';
import { ANTIGRAVITY_MODEL_CONFIG_ID, type AntigravityModel, readAntigravitySessionModels } from '../models';
import { resolveAntigravityLaunchSpec } from '../runtime/AntigravityExecutionContext';

export interface AntigravityMetadata {
  readonly commands: SlashCommand[];
  readonly currentModelId: string | null;
  readonly models: AntigravityModel[];
}

const ABORT_MESSAGE = 'Antigravity metadata probe aborted';
const DISPOSED_MESSAGE = 'Antigravity metadata probe is disposed.';
/** agy publishes commands in a notification shortly after `session/new` returns. */
const COMMANDS_WAIT_MS = 3_000;

/**
 * Reads models and commands from a prompt-less session that is closed at once. agy does not
 * list such sessions, so discovery leaves no visible conversation behind.
 */
export class AntigravityMetadataProbe {
  private disposeFlight: Promise<void> | null = null;
  private inFlight: Promise<AntigravityMetadata> | null = null;
  private readonly probes = new OwnedProbeRegistry<AntigravityNativeConnection>({
    abortMessage: ABORT_MESSAGE,
    dispose: native => native.shutdown(),
    unavailableError: () => new Error(DISPOSED_MESSAGE),
  });
  private readonly transitionFence = new ProviderTransitionFence({ abortMessage: ABORT_MESSAGE });

  constructor(private readonly host: ProviderRuntimeHost) {}

  /** Concurrent callers share one probe. */
  async load(signal?: AbortSignal): Promise<AntigravityMetadata> {
    if (this.transitionFence.isUnavailable()) {
      const available = await this.transitionFence.waitUntilAvailable(signal);
      if (!available) throw new Error(DISPOSED_MESSAGE);
    }
    if (signal?.aborted) throw new Error(ABORT_MESSAGE);
    if (!this.inFlight) {
      const flight = this.#probe();
      this.inFlight = flight;
      const clear = () => { if (this.inFlight === flight) this.inFlight = null; };
      flight.then(clear, clear);
    }
    const flight = this.inFlight;
    if (!signal) return flight;
    let onAbort: (() => void) | undefined;
    const aborted = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(new Error(ABORT_MESSAGE));
      signal.addEventListener('abort', onAbort, { once: true });
    });
    try {
      return await Promise.race([flight, aborted]);
    } finally {
      signal.removeEventListener('abort', onAbort!);
    }
  }

  #probe(): Promise<AntigravityMetadata> {
    return this.probes.run({
      create: async (ownedSignal) => {
        const launch = await resolveAntigravityLaunchSpec(this.host, ANTIGRAVITY_ACP_ARGS);
        ownedSignal.throwIfAborted();
        return new AntigravityNativeConnection({
          launch,
          requestPermission: async () => ({ outcome: { outcome: 'cancelled' } }),
          version: this.host.clientVersion ?? '0.0.0',
        });
      },
      initialize: native => native.initialize(),
      query: async (native, ownedSignal) => {
        let resolveCommands!: (commands: SlashCommand[]) => void;
        const commandsReceived = new Promise<SlashCommand[]>(resolve => { resolveCommands = resolve; });
        let sessionId: string | null = null;
        const pending: ACPSessionNotification[] = [];
        const accept = (notification: ACPSessionNotification) => {
          if (notification.update.sessionUpdate === 'available_commands_update' && notification.sessionId === sessionId) {
            resolveCommands(normalizeACPAvailableCommands(notification.update.availableCommands));
          }
        };
        const unsubscribe = native.onNotification(notification => {
          if (sessionId) accept(notification);
          else pending.push(notification);
        });
        try {
          const response = await native.newSession({ cwd: native.launch.targetCwd, mcpServers: [] });
          sessionId = response.sessionId;
          pending.splice(0).forEach(accept);
          let timer: number | undefined;
          const commands = await Promise.race([
            commandsReceived,
            new Promise<SlashCommand[]>(resolve => { timer = window.setTimeout(() => resolve([]), COMMANDS_WAIT_MS); }),
          ]).finally(() => window.clearTimeout(timer));
          ownedSignal.throwIfAborted();
          const { currentModelId, models } = readAntigravitySessionModels(response.configOptions);
          const discovered = await readThinkingLevels(native, response.sessionId, currentModelId, models, ownedSignal);
          await native.closeSession(response.sessionId).catch(() => undefined);
          return { commands, currentModelId, models: discovered };
        } finally {
          unsubscribe();
        }
      },
    });
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
    this.disposeFlight = this.probes.dispose();
    return this.disposeFlight;
  }
}

/**
 * agy reports thinking levels only for the session's current model, and none for fixed-effort models, so each
 * model is selected once on the probe session to read its own levels; the original model is selected again after.
 */
async function readThinkingLevels(
  native: AntigravityNativeConnection,
  sessionId: string,
  currentModelId: string | null,
  models: readonly AntigravityModel[],
  signal: AbortSignal,
): Promise<AntigravityModel[]> {
  const discovered: AntigravityModel[] = [];
  let changed = false;
  for (const model of models) {
    if (model.rawId === currentModelId) {
      discovered.push(model);
      continue;
    }
    changed = true;
    const response = await native.setConfigOption({ configId: ANTIGRAVITY_MODEL_CONFIG_ID, sessionId, value: model.rawId });
    signal.throwIfAborted();
    const reported = readAntigravitySessionModels(response.configOptions).models.find(entry => entry.rawId === model.rawId);
    discovered.push({ ...model, reasoningEfforts: reported?.reasoningEfforts ?? [] });
  }
  if (changed && currentModelId) {
    await native.setConfigOption({ configId: ANTIGRAVITY_MODEL_CONFIG_ID, sessionId, value: currentModelId });
  }
  return discovered;
}
