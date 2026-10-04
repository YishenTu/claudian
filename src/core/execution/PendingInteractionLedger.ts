import type {
  ProviderInteractionDismissReason,
  ProviderInteractionPort,
} from './ProviderInteractionPort';

export interface PendingInteraction {
  readonly interactionId: string;
  /** Aborts when the ledger dismisses this interaction or its caller aborts. */
  readonly signal: AbortSignal;
}

interface LedgerEntry extends PendingInteraction {
  readonly controller: AbortController;
  readonly detachCaller: () => void;
}

/**
 * Provider-side record of interactions forwarded to a `ProviderInteractionPort`.
 *
 * Each interaction is dismissed at most once: settling, aborting, or a
 * caller abort removes it before the port is told. Native request handling
 * and dismissal reasons stay with the provider.
 */
export class PendingInteractionLedger {
  readonly #entries = new Map<string, LedgerEntry>();

  constructor(
    private readonly port: Pick<ProviderInteractionPort, 'dismissInteraction'>,
  ) {}

  get size(): number {
    return this.#entries.size;
  }

  has(interactionId: string): boolean {
    return this.#entries.has(interactionId);
  }

  /**
   * Registers an interaction, or returns null when the id is already pending.
   * A caller abort dismisses it as `cancelled`; an already-aborted caller
   * yields an aborted interaction that is never registered or dismissed.
   */
  begin(
    interactionId: string,
    callerSignal?: AbortSignal,
  ): PendingInteraction | null {
    if (this.#entries.has(interactionId)) return null;
    const controller = new AbortController();
    if (callerSignal?.aborted) {
      controller.abort();
      return { interactionId, signal: controller.signal };
    }
    const onCallerAbort = (): void => {
      this.abort(interactionId, 'cancelled');
    };
    callerSignal?.addEventListener('abort', onCallerAbort, { once: true });
    const entry: LedgerEntry = {
      interactionId,
      signal: controller.signal,
      controller,
      detachCaller: () => callerSignal?.removeEventListener('abort', onCallerAbort),
    };
    this.#entries.set(interactionId, entry);
    return entry;
  }

  /** True when the response echoes another identity or the interaction is no longer pending. */
  isStaleResponse(
    pending: PendingInteraction,
    response: { readonly interactionId: string },
  ): boolean {
    return response.interactionId !== pending.interactionId
      || this.#entries.get(pending.interactionId) !== pending;
  }

  /** Dismisses a still-pending interaction once; returns whether this call dismissed it. */
  settle(
    pending: PendingInteraction,
    reason: ProviderInteractionDismissReason,
  ): boolean {
    if (this.#entries.get(pending.interactionId) !== pending) return false;
    this.#dismiss(pending.interactionId, reason);
    return true;
  }

  /** Forgets a pending interaction without dismissing it, e.g. after the port completed it. */
  release(pending: PendingInteraction): void {
    const entry = this.#entries.get(pending.interactionId);
    if (entry !== pending) return;
    this.#entries.delete(pending.interactionId);
    entry.detachCaller();
  }

  /** Dismisses once, then aborts the forwarded request. */
  abort(
    interactionId: string,
    reason: ProviderInteractionDismissReason,
  ): boolean {
    const entry = this.#dismiss(interactionId, reason);
    entry?.controller.abort();
    return entry !== null;
  }

  dismissAll(reason: ProviderInteractionDismissReason): void {
    for (const interactionId of [...this.#entries.keys()]) {
      this.abort(interactionId, reason);
    }
  }

  #dismiss(
    interactionId: string,
    reason: ProviderInteractionDismissReason,
  ): LedgerEntry | null {
    const entry = this.#entries.get(interactionId);
    if (!entry) return null;
    this.#entries.delete(interactionId);
    entry.detachCaller();
    this.port.dismissInteraction(interactionId, reason);
    return entry;
  }
}
