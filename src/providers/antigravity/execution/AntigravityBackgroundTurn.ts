import { randomUUID } from 'node:crypto';

import type { ProviderBackgroundTurnCompletionReason, ProviderSessionEvent } from '@/core/execution';
import {
  ACPExecutionEventNormalizer,
  type ACPNormalizedUpdate,
  type ACPSessionNotification,
  buildACPUsageInfo,
} from '@/providers/acp';

import { createAntigravityToolStreamAdapter, presentAntigravityUpdate } from '../normalization/antigravityToolNormalization';

/**
 * agy ends every model call with `usage_update` and streams that call's tool calls within milliseconds of it, so a
 * reply is over once nothing follows its `usage_update` for this long. A tool call keeps the reply open until the next
 * `usage_update`, including while it waits for an approval or answer (agy asks only after streaming the call). A denial ends agy's reply at the denied call's
 * failure, with no `usage_update`. A turn closed early only splits the reply: later output opens another background
 * turn.
 */
const SETTLE_AFTER_USAGE_MS = 1_000;

/** Reply output: it opens a background turn and shows agy is still replying. Metadata (usage, config) does neither. */
export const ANTIGRAVITY_REPLY_OUTPUT_KINDS: ReadonlySet<string> = new Set([
  'agent_message_chunk', 'agent_thought_chunk', 'plan', 'tool_call', 'tool_call_update',
]);

export interface AntigravityBackgroundTurnOptions {
  readonly notify: (event: ProviderSessionEvent) => void;
  /** Called once the reply has settled; the owner then completes the turn. */
  readonly onSettled: () => void;
  readonly providerSessionId: string | undefined;
  readonly sessionInstanceId: string;
  readonly takeAnswers: Parameters<typeof createAntigravityToolStreamAdapter>[0];
}

/**
 * Work agy does on its own between prompts (its reply to a finished subagent or background command), streamed live
 * with no turn boundary: agy sends no echo, start or stop for it.
 */
export class AntigravityBackgroundTurn {
  readonly turnId = randomUUID();
  readonly #closed = new AbortController();
  /** Tool calls this turn has streamed. */
  readonly #toolCallIds = new Set<string>();
  /** Calls whose approval was not granted; agy's reply ends when one fails. */
  readonly #deniedToolCallIds = new Set<string>();
  readonly #normalizer: ACPExecutionEventNormalizer;
  #sequence = 0;
  #settleTimer: number | undefined;

  constructor(private readonly options: AntigravityBackgroundTurnOptions) {
    this.#normalizer = new ACPExecutionEventNormalizer({
      mapUsage: usage => buildACPUsageInfo({ contextWindow: usage }),
      scope: { kind: 'background', sessionInstanceId: options.sessionInstanceId, turnId: this.turnId },
      toolStreamAdapter: createAntigravityToolStreamAdapter(options.takeAnswers),
    });
    options.notify({ providerSessionId: options.providerSessionId, scope: this.#nextScope(), type: 'background_turn_started' });
  }

  /** Aborts once the turn has closed, dismissing approvals and questions it still shows. */
  get signal(): AbortSignal {
    return this.#closed.signal;
  }

  handleUpdate(update: ACPSessionNotification['update'] & { name?: unknown }): ACPNormalizedUpdate | undefined {
    if (this.signal.aborted) return undefined;
    // A settings change the next run makes is not agy replying.
    if (ANTIGRAVITY_REPLY_OUTPUT_KINDS.has(update.sessionUpdate)) window.clearTimeout(this.#settleTimer);
    const { events, metadata } = this.#normalizer.normalize(presentAntigravityUpdate(this.#toolCallIds, update));
    // The turn's start and completion share its sequence, so it numbers the normalized events itself.
    for (const event of events) this.options.notify({ ...event, scope: this.#nextScope() });
    const deniedCallFailed = update.sessionUpdate === 'tool_call_update' && update.status === 'failed'
      && this.#deniedToolCallIds.has(update.toolCallId);
    if (metadata?.type === 'usage' || deniedCallFailed) {
      window.clearTimeout(this.#settleTimer);
      this.#settleTimer = window.setTimeout(() => this.options.onSettled(), SETTLE_AFTER_USAGE_MS);
    }
    return metadata;
  }

  toolDenied(toolCallId: string): void {
    this.#deniedToolCallIds.add(toolCallId);
  }

  close(reason: ProviderBackgroundTurnCompletionReason): void {
    if (this.signal.aborted) return;
    window.clearTimeout(this.#settleTimer);
    this.#closed.abort();
    this.#normalizer.dispose();
    this.options.notify({
      providerSessionId: this.options.providerSessionId,
      reason,
      scope: this.#nextScope(),
      type: 'background_turn_completed',
    });
  }

  #nextScope() {
    return { kind: 'background' as const, sequence: ++this.#sequence, sessionInstanceId: this.options.sessionInstanceId, turnId: this.turnId };
  }
}
