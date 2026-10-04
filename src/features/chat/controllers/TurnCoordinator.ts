/** Why an admitted turn is being cancelled; non-user reasons also release its presentation. */
export type TurnCancelReason = 'user' | 'new-conversation' | 'shutdown';

/**
 * Response progress after admission: input preparation (session references, branch commit,
 * Conversation shell), the provider-facing response, then rendering and persistence settlement.
 */
export type TurnPhase = 'preparing' | 'responding' | 'settling';

/** Read side of one foreground turn owner, for presentation state that derives from it. */
export interface TurnActivity {
  /** A response is admitted and has not reached settlement; it can still be cancelled. */
  readonly isInFlight: boolean;
  /** Recorded for the rest of the admitted turn, through settlement; provider events cannot clear it. */
  readonly cancelRequested: boolean;
  /** Identifies the response that owns streaming presentation; invalidation supersedes it. */
  readonly streamGeneration: number;
  subscribe(listener: () => void): () => void;
}

/** Owns one admitted response or navigation through final rendering and persistence. */
export class TurnCoordinator implements TurnActivity {
  #activeTurn: Promise<void> | null = null;
  #controller: AbortController | null = null;
  #kind: 'response' | 'navigation' | null = null;
  #phase: TurnPhase | null = null;
  #cancelRequested = false;
  #streamGeneration = 0;
  readonly #listeners = new Set<() => void>();

  constructor(private readonly canAdmit: () => boolean = () => true) {}

  /** Any admitted response or navigation, from admission through settlement. */
  get isActive(): boolean {
    return this.#activeTurn !== null;
  }

  /** An admitted response, from admission through settlement. */
  get isResponseActive(): boolean {
    return this.#kind === 'response';
  }

  get isPreparing(): boolean {
    return this.#phase === 'preparing';
  }

  /** The provider-facing response is running, so follow-up input may steer it. */
  get isResponding(): boolean {
    return this.#phase === 'responding';
  }

  get isInFlight(): boolean {
    return this.#phase === 'preparing' || this.#phase === 'responding';
  }

  get cancelRequested(): boolean {
    return this.#cancelRequested;
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
    return this.#activeTurn ?? Promise.resolve();
  }

  /** Records the request for the rest of the turn and aborts its signal; returns false when idle. */
  cancel(reason: TurnCancelReason = 'user'): boolean {
    if (!this.#activeTurn) return false;
    this.#cancelRequested = true;
    // Replacement and teardown discard the turn's remaining presentation work.
    if (reason !== 'user') this.#streamGeneration += 1;
    this.#controller?.abort(reason);
    return true;
  }

  /** Starts the provider-facing response and returns the generation that owns its presentation. */
  beginResponse(): number {
    if (this.#kind !== 'response') throw new Error('No admitted response can begin');
    this.#streamGeneration += 1;
    this.#setPhase('responding');
    return this.#streamGeneration;
  }

  /** Ends streaming presentation; the turn stays admitted until rendering and persistence finish. */
  settle(): void {
    if (this.#kind === 'response') this.#setPhase('settling');
  }

  async run(execute: (signal: AbortSignal) => Promise<void>, kind: 'response' | 'navigation' = 'response'): Promise<void> {
    if (this.#activeTurn) throw new Error('A main turn is already active');
    if (!this.canAdmit()) throw new Error('Conversation operation admission is closed.');
    let settle!: () => void;
    this.#activeTurn = new Promise<void>(resolve => { settle = resolve; });
    this.#kind = kind;
    this.#phase = kind === 'response' ? 'preparing' : null;
    this.#cancelRequested = false;
    this.#controller = new AbortController();
    try {
      const execution = execute(this.#controller.signal);
      try {
        this.#notify();
      } finally {
        // An observer failure must not release ownership of running work.
        await execution;
      }
    } finally {
      this.#controller = null;
      this.#activeTurn = null;
      this.#kind = null;
      this.#phase = null;
      this.#cancelRequested = false;
      settle();
      this.#notify();
    }
  }

  #setPhase(phase: TurnPhase): void {
    if (this.#phase === phase) return;
    this.#phase = phase;
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
