import type {
  ProviderApprovalInteractionRequest,
  ProviderInteractionDismissReason,
  ProviderInteractionIdentity,
  ProviderInteractionPort,
  ProviderQuestionInteractionRequest,
} from '@/core/execution';

interface ExecutionInteractionsDeps {
  readonly port: ProviderInteractionPort;
  isCurrent(request: ProviderInteractionIdentity): boolean;
  staleError(interactionId: string): Error;
  onPendingChange?(): void;
}

/** Owns live provider requests; late replies cannot resolve or remove another request. */
export class ExecutionInteractions implements ProviderInteractionPort {
  readonly #pending = new Map<string, ProviderInteractionIdentity>();

  constructor(private readonly deps: ExecutionInteractionsDeps) {}

  get hasPending(): boolean {
    return this.#pending.size > 0;
  }

  requestApproval(request: ProviderApprovalInteractionRequest, signal: AbortSignal) {
    return this.#forward(request, signal, () => this.deps.port.requestApproval(request, signal));
  }

  askUserQuestion(request: ProviderQuestionInteractionRequest, signal: AbortSignal) {
    return this.#forward(request, signal, () => this.deps.port.askUserQuestion(request, signal));
  }

  dismissInteraction(id: string, reason: ProviderInteractionDismissReason): void {
    this.#pending.delete(id);
    this.deps.port.dismissInteraction(id, reason);
    this.deps.onPendingChange?.();
  }

  dismissTurn(turnId: string, reason: ProviderInteractionDismissReason): void {
    for (const [id, pending] of this.#pending) {
      if (pending.turnId === turnId) this.dismissInteraction(id, reason);
    }
  }

  dismissAll(reason: ProviderInteractionDismissReason): void {
    for (const id of this.#pending.keys()) this.dismissInteraction(id, reason);
  }

  async #forward<T extends { interactionId: string }>(
    request: ProviderInteractionIdentity,
    signal: AbortSignal,
    forward: () => Promise<T>,
  ): Promise<T> {
    if (!this.deps.isCurrent(request) || signal.aborted) throw this.deps.staleError(request.interactionId);
    if (this.#pending.has(request.interactionId)) throw new Error(`Duplicate provider interaction: ${request.interactionId}`);
    const pending = { ...request };
    this.#pending.set(request.interactionId, pending);
    this.deps.onPendingChange?.();
    try {
      const response = await forward();
      if (response.interactionId !== request.interactionId || signal.aborted
        || this.#pending.get(request.interactionId) !== pending || !this.deps.isCurrent(request)) {
        throw this.deps.staleError(request.interactionId);
      }
      return response;
    } finally {
      if (this.#pending.get(request.interactionId) === pending) {
        this.#pending.delete(request.interactionId);
        this.deps.onPendingChange?.();
      }
    }
  }
}
