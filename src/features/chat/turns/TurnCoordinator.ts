import type { TurnActivity } from '@/features/chat/state/types';

/** Why an admitted turn is being cancelled; non-user reasons also release its presentation. */
export type TurnCancelReason = 'user' | 'new-conversation' | 'shutdown';

/**
 * Response progress after admission: input preparation (session references, branch commit,
 * Conversation shell), the provider-facing response, then rendering and persistence settlement.
 */
export type TurnPhase = 'preparing' | 'responding' | 'settling';

interface AdmittedTurn {
  readonly settled: Promise<void>;
  readonly controller: AbortController;
  /** A navigation has no response phases. */
  readonly kind: 'response' | 'navigation';
  phase: TurnPhase | null;
  cancelRequested: boolean;
}

/** Owns one admitted response or navigation through final rendering and persistence. */
export class TurnCoordinator implements TurnActivity {
  #turn: AdmittedTurn | null = null;
  #streamGeneration = 0;
  readonly #listeners = new Set<() => void>();

  constructor(private readonly canAdmit: () => boolean = () => true) {}

  /** Any admitted response or navigation, from admission through settlement. */
  get isActive(): boolean {
    return this.#turn !== null;
  }

  /** An admitted response, from admission through settlement. */
  get isResponseActive(): boolean {
    return this.#turn?.kind === 'response';
  }

  get isPreparing(): boolean {
    return this.#turn?.phase === 'preparing';
  }

  /** The provider-facing response is running, so follow-up input may steer it. */
  get isResponding(): boolean {
    return this.#turn?.phase === 'responding';
  }

  get isInFlight(): boolean {
    const phase = this.#turn?.phase;
    return phase === 'preparing' || phase === 'responding';
  }

  get cancelRequested(): boolean {
    return this.#turn?.cancelRequested ?? false;
  }

  get streamGeneration(): number {
    return this.#streamGeneration;
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  drain(): Promise<void> {
    return this.#turn?.settled ?? Promise.resolve();
  }

  /** Records the request for the rest of the turn and aborts its signal; returns false when idle. */
  cancel(reason: TurnCancelReason = 'user'): boolean {
    const turn = this.#turn;
    if (!turn) return false;
    turn.cancelRequested = true;
    // Replacement and teardown discard the turn's remaining presentation work.
    if (reason !== 'user') this.#streamGeneration += 1;
    turn.controller.abort(reason);
    return true;
  }

  /** Starts the provider-facing response and returns the generation that owns its presentation. */
  beginResponse(): number {
    if (this.#turn?.kind !== 'response') throw new Error('No admitted response can begin');
    this.#streamGeneration += 1;
    this.#setPhase('responding');
    return this.#streamGeneration;
  }

  /** Ends streaming presentation; the turn stays admitted until rendering and persistence finish. */
  settle(): void {
    if (this.#turn?.kind === 'response') this.#setPhase('settling');
  }

  async run(execute: (signal: AbortSignal) => Promise<void>, kind: 'response' | 'navigation' = 'response'): Promise<void> {
    if (this.#turn) throw new Error('A main turn is already active');
    if (!this.canAdmit()) throw new Error('Conversation operation admission is closed.');
    let settle!: () => void;
    const turn: AdmittedTurn = {
      cancelRequested: false,
      controller: new AbortController(),
      kind,
      phase: kind === 'response' ? 'preparing' : null,
      settled: new Promise<void>(resolve => { settle = resolve; }),
    };
    this.#turn = turn;
    try {
      const execution = execute(turn.controller.signal);
      try {
        this.#notify();
      } finally {
        // An observer failure must not release ownership of running work.
        await execution;
      }
    } finally {
      this.#turn = null;
      settle();
      this.#notify();
    }
  }

  #setPhase(phase: TurnPhase): void {
    const turn = this.#turn;
    if (!turn || turn.phase === phase) return;
    turn.phase = phase;
    this.#notify();
  }

  #notify(): void {
    let failure: { error: unknown } | null = null;
    for (const listener of [...this.#listeners]) {
      try {
        listener();
      } catch (error) {
        failure ??= { error };
      }
    }
    if (failure) throw failure.error;
  }
}
