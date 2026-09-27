/** Owns one admitted response or navigation through final rendering and persistence. */
export class TurnCoordinator {
  private activeTurn: Promise<void> | null = null;
  private controller: AbortController | null = null;
  private activeKind: 'response' | 'navigation' | null = null;

  constructor(private readonly onWorkChanged?: () => void, private readonly canAdmit: () => boolean = () => true) {}

  get isActive(): boolean {
    return this.activeTurn !== null;
  }

  get isResponseActive(): boolean {
    return this.activeKind === 'response';
  }

  drain(): Promise<void> {
    return this.activeTurn ?? Promise.resolve();
  }

  cancel(reason: 'user' | 'shutdown' = 'user'): void {
    this.controller?.abort(reason);
  }

  async run(execute: (signal: AbortSignal) => Promise<void>, kind: 'response' | 'navigation' = 'response'): Promise<void> {
    if (this.activeTurn) throw new Error('A main turn is already active');
    if (!this.canAdmit()) throw new Error('Conversation operation admission is closed.');
    let settle!: () => void;
    this.activeTurn = new Promise<void>(resolve => { settle = resolve; });
    this.activeKind = kind;
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
      this.activeKind = null;
      settle();
      this.onWorkChanged?.();
    }
  }
}
