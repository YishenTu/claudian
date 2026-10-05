import type { ComposerDestination } from '@/features/chat/composer/ComposerDraftController';

/**
 * Owns submissions still preparing before their destination admits them, and the barrier that
 * keeps busy-main admission in submission order while earlier preparation can yield.
 */
export class SubmissionPreparations {
  private readonly preparations = new Map<AbortController, { destination: ComposerDestination; pending: Promise<void> }>();
  private mainAdmissionBarrier: Promise<void> | null = null;

  /** Admission still reserved by an earlier main submission. */
  get pendingMainAdmission(): Promise<void> | null {
    return this.mainAdmissionBarrier;
  }

  /** Reserves the next main admission slot; the returned release is idempotent. */
  reserveMainAdmission(): () => void {
    let release!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; });
    this.mainAdmissionBarrier = barrier;
    return () => {
      release();
      if (this.mainAdmissionBarrier === barrier) this.mainAdmissionBarrier = null;
    };
  }

  /** Tracks a preparation until it settles; its controller is how cancellation reaches it. */
  async track(controller: AbortController, destination: ComposerDestination, pending: Promise<void>): Promise<void> {
    this.preparations.set(controller, { destination, pending });
    try {
      await pending;
    } finally {
      this.preparations.delete(controller);
    }
  }

  isPreparing(destination: ComposerDestination): boolean {
    return [...this.preparations].some(([controller, preparation]) =>
      preparation.destination === destination && !controller.signal.aborted);
  }

  abort(destination: ComposerDestination): void {
    for (const [controller, preparation] of this.preparations) {
      if (preparation.destination === destination) controller.abort();
    }
  }

  /** Waits for every preparation tracked now, without cancelling it. */
  settled(): Promise<unknown> {
    return Promise.allSettled([...this.preparations.values()].map(value => value.pending));
  }

  /** Cancels and joins every preparation. */
  async drain(): Promise<void> {
    const pending = this.settled();
    for (const controller of this.preparations.keys()) controller.abort();
    await pending;
  }
}
