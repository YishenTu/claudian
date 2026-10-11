import type { AppTabManagerState } from '@/core/bootstrap/tabManagerState';

type TimerHost = Pick<Window, 'clearTimeout' | 'setTimeout'>;

/**
 * Detects tab-state changes and serializes the writes that persist them. It keeps no snapshot:
 * `write` persists whatever the host currently reports (Obsidian pulls the view's `getState()`),
 * and an update is acknowledged once a write that started after it settles.
 */
export class TabStatePersistenceCoordinator {
  private timer: number | null = null;
  private latestSerialized: string | null = null;
  private acknowledgedSerialized: string | null = null;
  private writePromise: Promise<void> | null = null;
  private disposed = false;

  constructor(
    private readonly write: () => Promise<void>,
    private readonly timerHost: TimerHost = window,
    private readonly debounceMs = 300,
  ) {}

  /** Records the current state; schedules a debounced write when it differs from the last written one. */
  update(state: AppTabManagerState): void {
    if (this.disposed) return;

    const serialized = JSON.stringify(state);
    this.latestSerialized = serialized;
    this.#cancelTimer();

    if (serialized === this.acknowledgedSerialized) return;
    this.timer = this.timerHost.setTimeout(() => {
      this.timer = null;
      void this.flush().catch(() => {
        // The change stays unacknowledged for a later update or close flush.
      });
    }, this.debounceMs);
  }

  /** Writes until the latest recorded change is acknowledged. */
  async flush(): Promise<void> {
    this.#cancelTimer();
    while (this.#hasUnwrittenChange()) {
      await (this.writePromise ?? this.#startWriteLoop());
    }
  }

  dispose(): void {
    this.disposed = true;
    this.#cancelTimer();
  }

  #hasUnwrittenChange(): boolean {
    return this.latestSerialized !== null && this.latestSerialized !== this.acknowledgedSerialized;
  }

  #startWriteLoop(): Promise<void> {
    const run = this.#writeUntilCurrent();
    this.writePromise = run;
    const settle = (): void => {
      if (this.writePromise === run) this.writePromise = null;
    };
    void run.then(settle, settle);
    return run;
  }

  async #writeUntilCurrent(): Promise<void> {
    while (this.#hasUnwrittenChange()) {
      const serialized = this.latestSerialized;
      await this.write();
      this.acknowledgedSerialized = serialized;
    }
  }

  #cancelTimer(): void {
    if (this.timer === null) return;
    this.timerHost.clearTimeout(this.timer);
    this.timer = null;
  }
}
