export interface ActiveTurnOwner {
  activeTurn: Promise<void> | null;
}

/** Owns the lifetime of the existing turn orchestration without changing its phases. */
export class TurnCoordinator<TRequest> {
  private activeTurn: Promise<void> | null = null;

  constructor(
    private readonly executeTurn: (request?: TRequest) => Promise<void>,
    private readonly owner?: ActiveTurnOwner,
  ) {}

  get current(): Promise<void> | null {
    return this.activeTurn;
  }

  async run(request?: TRequest): Promise<void> {
    const execution = this.executeTurn(request);
    this.activeTurn = execution;
    if (this.owner) this.owner.activeTurn = execution;

    try {
      await execution;
    } finally {
      if (this.activeTurn === execution) this.activeTurn = null;
      if (this.owner?.activeTurn === execution) this.owner.activeTurn = null;
    }
  }
}
