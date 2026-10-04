import type { RequestedRunChannel } from '../../core/execution';
import { ACPExecutionEventNormalizer } from './ACPExecutionEventNormalizer';
import type { ACPNormalizedUpdate } from './ACPSessionUpdateNormalizer';
import type { ACPToolStreamAdapter } from './ACPToolStreamAdapter';
import { buildACPUsageInfo } from './buildACPUsageInfo';
import type { ACPUsageUpdate } from './types';

/** ACP session updates that describe session metadata and never carry turn output. */
export type ACPSessionMetadataUpdate = Extract<
  ACPNormalizedUpdate,
  { type: 'commands' | 'config_options' | 'current_mode' }
>;

export interface ACPRequestedTurnOptions {
  readonly run: RequestedRunChannel;
  /** Provider-owned tool normalization. */
  readonly toolStreamAdapter?: ACPToolStreamAdapter;
  /** Model attributed to live context-window usage. */
  readonly resolveUsageModel?: () => string | undefined;
  /** Runs once, before `turn_started`, when the native turn is first accepted. */
  readonly onAccept?: () => void;
  /** Whether a live update that yields no events still proves acceptance. */
  readonly acceptsSilentUpdates?: boolean;
}

/**
 * Protocol mechanics of one requested ACP prompt turn: normalizes session
 * updates, captures live context usage, gates output to the live prompt,
 * accepts the turn once, and re-sequences events into the requested run.
 * Update pre-normalization and metadata handling stay with the provider.
 */
export class ACPRequestedTurn {
  readonly #options: ACPRequestedTurnOptions;
  readonly #normalizer: ACPExecutionEventNormalizer;
  #accepted = false;
  #acceptingLiveOutput = false;
  #contextUsage: ACPUsageUpdate | null = null;

  constructor(options: ACPRequestedTurnOptions) {
    this.#options = options;
    const { run } = options;
    this.#normalizer = new ACPExecutionEventNormalizer({
      mapUsage: usage => {
        if (this.acceptingLiveOutput) this.#contextUsage = usage;
        return buildACPUsageInfo({
          contextWindow: usage,
          model: options.resolveUsageModel?.(),
        });
      },
      scope: {
        executionId: run.executionId,
        kind: 'requested',
        sessionInstanceId: run.sessionInstanceId,
        turnId: run.turnId,
      },
      toolStreamAdapter: options.toolStreamAdapter,
    });
  }

  get accepted(): boolean {
    return this.#accepted;
  }

  /** True between `beginLiveOutput()` and `endLiveOutput()` while the run is open. */
  get acceptingLiveOutput(): boolean {
    return this.#acceptingLiveOutput && !this.#options.run.isTerminal;
  }

  /** Latest context-window usage reported during live output. */
  get contextUsage(): ACPUsageUpdate | null {
    return this.#contextUsage;
  }

  /** Starts live output for the prompt about to be sent; earlier replay state is discarded. */
  beginLiveOutput(): void {
    this.#normalizer.reset();
    this.#acceptingLiveOutput = true;
  }

  endLiveOutput(): void {
    this.#acceptingLiveOutput = false;
  }

  accept(nativeUserMessageId?: string | null): void {
    if (this.#accepted || this.#options.run.isTerminal) return;
    this.#accepted = true;
    this.#options.onAccept?.();
    this.#options.run.emit({
      accepted: true,
      ...(nativeUserMessageId ? { nativeUserMessageId } : {}),
      type: 'turn_started',
    });
  }

  /**
   * Normalizes one session update. Metadata is returned for provider handling;
   * live output is accepted and emitted into the run.
   */
  handleUpdate(update: unknown): ACPSessionMetadataUpdate | undefined {
    const result = this.#normalizer.normalize(update);
    if (result.metadata && isSessionMetadataUpdate(result.metadata)) {
      return result.metadata;
    }
    if (!this.acceptingLiveOutput) return undefined;
    if (result.events.length === 0 && !this.#options.acceptsSilentUpdates) {
      return undefined;
    }
    this.accept();
    for (const event of result.events) {
      this.#options.run.emit(event);
    }
    return undefined;
  }

  dispose(): void {
    this.#normalizer.dispose();
  }
}

function isSessionMetadataUpdate(
  update: ACPNormalizedUpdate,
): update is ACPSessionMetadataUpdate {
  return update.type === 'commands'
    || update.type === 'config_options'
    || update.type === 'current_mode';
}
