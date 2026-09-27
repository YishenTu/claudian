/** Owns one admitted main turn through its final rendering and persistence. */
export class TurnCoordinator {
  private activeTurn: Promise<void> | null = null;

  constructor(private readonly onWorkChanged?: () => void) {}

  get isActive(): boolean {
    return this.activeTurn !== null;
  }

  drain(): Promise<void> {
    return this.activeTurn ?? Promise.resolve();
  }

  async run(execute: () => Promise<void>): Promise<void> {
    if (this.activeTurn) throw new Error('A main turn is already active');
    let settle!: () => void;
    this.activeTurn = new Promise<void>(resolve => { settle = resolve; });
    try {
      const execution = execute();
      try {
        this.onWorkChanged?.();
      } finally {
        // An observer failure must not release ownership of running work.
        await execution;
      }
    } finally {
      this.activeTurn = null;
      settle();
      this.onWorkChanged?.();
    }
  }
}
