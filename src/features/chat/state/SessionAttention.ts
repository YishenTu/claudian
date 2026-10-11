import type { TabAttention, TabReviewOutcome } from '@/features/chat/state/types';

/** Small session record retained after main transcript eviction. */
export class SessionAttention {
  private attentionValue: TabAttention = null;
  private reviewEpochValue = 0;
  private pendingReview: { outcome: TabReviewOutcome; since: number } | null = null;
  private readonly listeners = new Set<() => void>();

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  get attention(): TabAttention {
    return this.attentionValue;
  }

  get requiresAction(): boolean {
    return this.attentionValue?.kind === 'action-required';
  }

  /** Called by the session interaction store; this is only its attention projection. */
  setActionRequired(required: boolean): void {
    if (required === this.requiresAction) return;
    if (required) {
      if (this.attentionValue?.kind === 'review' && this.pendingReview === null) {
        this.pendingReview = { outcome: this.attentionValue.outcome, since: this.attentionValue.since };
      }
      this.setAttention({ kind: 'action-required', since: Date.now() });
    } else {
      const review = this.pendingReview;
      this.pendingReview = null;
      this.setAttention(review === null ? null : { kind: 'review', ...review });
    }
  }

  markReviewRequired(outcome: TabReviewOutcome = 'completed'): void {
    if (this.attentionValue?.kind === 'review') {
      if (this.attentionValue.outcome === 'error' || outcome === 'completed') return;
      this.setAttention({
        kind: 'review',
        outcome: 'error',
        since: this.attentionValue.since,
      });
      return;
    }
    if (this.requiresAction) {
      if (this.pendingReview === null) {
        this.pendingReview = { outcome, since: Date.now() };
      } else if (outcome === 'error') {
        this.pendingReview.outcome = 'error';
      }
      return;
    }
    this.setAttention({ kind: 'review', outcome, since: Date.now() });
  }

  /**
   * Advances on every review acknowledgement (activation, a new turn). A settlement captured in an
   * earlier epoch was already seen by the user and must not request review.
   */
  get reviewEpoch(): number {
    return this.reviewEpochValue;
  }

  acknowledgeReview(): void {
    this.reviewEpochValue += 1;
    this.pendingReview = null;
    if (this.attentionValue?.kind === 'review') {
      this.setAttention(null);
    }
  }

  private setAttention(attention: TabAttention): void {
    const current = this.attentionValue;
    if (
      current === attention
      || (current !== null
        && attention !== null
        && current.kind === attention.kind
        && current.since === attention.since
        && (current.kind !== 'review'
          || attention.kind !== 'review'
          || current.outcome === attention.outcome))
    ) {
      return;
    }

    this.attentionValue = attention;
    for (const listener of this.listeners) listener();
  }
}
