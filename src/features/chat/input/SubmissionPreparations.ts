import { appendRawDraftSuffix, type ComposerDestination, type ComposerDraft } from '@/features/chat/composer/ComposerDraftController';

/** A main submission waiting for a history refresh, holding the input captured when it was sent. */
export interface HeldSubmission {
  /** Returns its consumed draft to the composer, exactly once across every caller. */
  recover(): void;
}

interface HeldEntry extends HeldSubmission {
  readonly sequence: number;
  readonly refresh: Promise<boolean>;
  readonly draft: ComposerDraft | null;
  returned: boolean;
  settle(proceed: boolean): void;
}

/**
 * Owns submissions not yet admitted by their destination: those still preparing, the barrier that keeps
 * busy-main admission in submission order while earlier preparation can yield, and main submissions
 * held while the shown history is checked and reloaded. Held submissions are input Stop can withdraw,
 * not session work: the check holding them still needs the session idle.
 */
export class SubmissionPreparations {
  private readonly preparations = new Map<AbortController, { destination: ComposerDestination; pending: Promise<void> }>();
  private mainAdmissionBarrier: Promise<void> | null = null;
  private historyRefresh: Promise<boolean> | null = null;
  private readonly held = new Set<HeldEntry>();
  private heldSequence = 0;

  constructor(private readonly deps: {
    onSettled?: () => void;
    /** Returns input to the composer ahead of anything typed since. */
    restoreDraft(draft: ComposerDraft): void;
  }) {}

  /** Main submissions wait for `refresh`: they go when it settles true and return to the composer otherwise. */
  holdForHistoryRefresh(refresh: Promise<boolean>): void {
    this.historyRefresh = refresh;
    void refresh.catch(() => false).then(refreshed => {
      if (this.historyRefresh === refresh) this.historyRefresh = null;
      const waiting = [...this.held].filter(entry => entry.refresh === refresh);
      if (refreshed) for (const entry of waiting) entry.settle(true);
      else this.returnHeld(waiting);
      this.deps.onSettled?.();
    });
  }

  get isHoldingForHistory(): boolean { return this.historyRefresh !== null; }

  get hasHeld(): boolean { return this.held.size > 0; }

  /**
   * Holds a main submission whose input was captured (`draft` when it was consumed from the composer)
   * until the pending history refresh settles. Resolves with the submission when it may be dispatched,
   * or null once its input was returned.
   */
  async holdUntilHistoryRefreshed(draft: ComposerDraft | null): Promise<HeldSubmission | null> {
    const refresh = this.historyRefresh;
    if (!refresh) throw new Error('No history refresh is pending');
    let settle!: (proceed: boolean) => void;
    const settled = new Promise<boolean>(resolve => { settle = resolve; });
    const entry: HeldEntry = {
      sequence: ++this.heldSequence, refresh, draft, returned: false, settle,
      recover: () => this.returnHeld([entry]),
    };
    this.held.add(entry);
    this.deps.onSettled?.();
    const proceed = await settled;
    this.held.delete(entry);
    this.deps.onSettled?.();
    return proceed && !entry.returned ? entry : null;
  }

  /** Stop: returns every held submission's input to the composer. */
  withdrawHeld(): boolean {
    const withdrawn = [...this.held];
    this.returnHeld(withdrawn);
    return withdrawn.length > 0;
  }

  /** Input returned together comes back as one block in submission order, ahead of later edits. */
  private returnHeld(entries: readonly HeldEntry[]): void {
    const returning = entries.filter(entry => !entry.returned).sort((a, b) => a.sequence - b.sequence);
    let block: ComposerDraft | null = null;
    for (const entry of returning) {
      entry.returned = true;
      this.held.delete(entry);
      if (entry.draft) {
        block = block
          ? { content: appendRawDraftSuffix(block.content, entry.draft.content), images: [...block.images, ...entry.draft.images] }
          : { content: entry.draft.content, images: [...entry.draft.images] };
      }
    }
    if (block) this.deps.restoreDraft(block);
    for (const entry of returning) entry.settle(false);
  }

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
      if (this.mainAdmissionBarrier === barrier) {
        this.mainAdmissionBarrier = null;
        this.deps.onSettled?.();
      }
    };
  }

  /** Tracks a preparation until it settles; its controller is how cancellation reaches it. */
  async track(controller: AbortController, destination: ComposerDestination, pending: Promise<void>): Promise<void> {
    this.preparations.set(controller, { destination, pending });
    try {
      await pending;
    } finally {
      this.preparations.delete(controller);
      this.deps.onSettled?.();
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

  /** Cancels and joins every preparation, returning held input. */
  async drain(): Promise<void> {
    this.withdrawHeld();
    const pending = this.settled();
    for (const controller of this.preparations.keys()) controller.abort();
    await pending;
  }
}
