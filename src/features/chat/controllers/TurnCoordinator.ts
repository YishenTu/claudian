/** Owns one admitted main turn through its final rendering and persistence. */
export class TurnCoordinator {
  private activeTurn: Promise<void> | null = null;
  private controller: AbortController | null = null;

  constructor(private readonly onWorkChanged?: () => void) {}

  get isActive(): boolean {
    return this.activeTurn !== null;
  }

  drain(): Promise<void> {
    return this.activeTurn ?? Promise.resolve();
  }

  cancel(reason: 'user' | 'shutdown' = 'user'): void {
    this.controller?.abort(reason);
  }

  async run(execute: (signal: AbortSignal) => Promise<void>): Promise<void> {
    if (this.activeTurn) throw new Error('A main turn is already active');
    let settle!: () => void;
    this.activeTurn = new Promise<void>(resolve => { settle = resolve; });
    this.controller = new AbortController();
    try {
      const execution = execute(this.controller.signal);
      try {
        this.onWorkChanged?.();
      } finally {
        // An observer failure must not release ownership of running work.
        await execution;
      }
    } finally {
      this.controller = null;
      this.activeTurn = null;
      settle();
      this.onWorkChanged?.();
    }
  }
}
