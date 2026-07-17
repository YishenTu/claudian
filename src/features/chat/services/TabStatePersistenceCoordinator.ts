import type { AppTabManagerState } from '../../../core/providers/types';

type TimerHost = Pick<Window, 'clearTimeout' | 'setTimeout'>;

/**
 * Owns the latest tab-layout snapshot and serializes persistence writes.
 */
export class TabStatePersistenceCoordinator {
  private timer: number | null = null;
  private latestState: AppTabManagerState | null = null;
  private latestSerialized: string | null = null;
  private acknowledgedSerialized: string | null = null;
  private writePromise: Promise<void> | null = null;
  private disposed = false;

  constructor(
    private readonly persist: (state: AppTabManagerState) => Promise<void>,
    private readonly timerHost: TimerHost = window,
    private readonly debounceMs = 300,
  ) {}

  update(state: AppTabManagerState): void {
    if (this.disposed) return;

    const serialized = JSON.stringify(state);
    this.latestSerialized = serialized;
    this.latestState = JSON.parse(serialized) as AppTabManagerState;
    this.cancelTimer();

    if (serialized === this.acknowledgedSerialized) return;
    this.timer = this.timerHost.setTimeout(() => {
      this.timer = null;
      void this.flush().catch(() => {
        // Keep the unacknowledged snapshot available for a later update or close flush.
      });
    }, this.debounceMs);
  }

  async flush(): Promise<void> {
    this.cancelTimer();

    while (
      this.latestState
      && this.latestSerialized
      && this.latestSerialized !== this.acknowledgedSerialized
    ) {
      const activeWrite = this.writePromise ?? this.startWriteLoop();
      await activeWrite;
    }
  }

  dispose(): void {
    this.disposed = true;
    this.cancelTimer();
  }

  private startWriteLoop(): Promise<void> {
    const run = this.writeLatestUntilCurrent();
    this.writePromise = run;
    void run.then(
      () => {
        if (this.writePromise === run) this.writePromise = null;
      },
      () => {
        if (this.writePromise === run) this.writePromise = null;
      },
    );
    return run;
  }

  private async writeLatestUntilCurrent(): Promise<void> {
    while (
      this.latestState
      && this.latestSerialized
      && this.latestSerialized !== this.acknowledgedSerialized
    ) {
      const state = this.latestState;
      const serialized = this.latestSerialized;
      await this.persist(state);
      this.acknowledgedSerialized = serialized;
    }
  }

  private cancelTimer(): void {
    if (this.timer === null) return;
    this.timerHost.clearTimeout(this.timer);
    this.timer = null;
  }
}
