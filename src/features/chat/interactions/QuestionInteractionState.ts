/** Where a prompt's answer is: being edited, being delivered, rejected by delivery, or settled for good. */
export type QuestionSubmissionPhase =
  | { readonly kind: 'editing' }
  | { readonly kind: 'submitting' }
  | { readonly kind: 'failed'; readonly error: string }
  | { readonly kind: 'resolved' };

/** Answer drafts and the submission phase a prompt shares with every surface that presents it. */
export class QuestionInteractionState {
  #phase: QuestionSubmissionPhase = { kind: 'editing' };
  readonly answers = new Map<number, Set<string>>();
  readonly customInputs = new Map<number, string>();
  activeTabIndex = 0;
  onChange?: () => void;

  get phase(): QuestionSubmissionPhase {
    return this.#phase;
  }

  get submitting(): boolean {
    return this.#phase.kind === 'submitting';
  }

  get resolved(): boolean {
    return this.#phase.kind === 'resolved';
  }

  /** Whether an answer can still be submitted: editing, or retrying after a failed delivery. */
  get acceptsAnswer(): boolean {
    return this.#phase.kind === 'editing' || this.#phase.kind === 'failed';
  }

  /** Starts delivering an answer; false when the prompt is already submitting or resolved. */
  beginSubmit(): boolean {
    if (!this.acceptsAnswer) return false;
    this.#phase = { kind: 'submitting' };
    return true;
  }

  /** Records a failed delivery so the answer can be retried; ignored unless a delivery is in flight. */
  failSubmit(error: string): boolean {
    if (this.#phase.kind !== 'submitting') return false;
    this.#phase = { kind: 'failed', error };
    return true;
  }

  /** Settles the prompt for good; false when it was already resolved. */
  resolve(): boolean {
    if (this.#phase.kind === 'resolved') return false;
    this.#phase = { kind: 'resolved' };
    return true;
  }
}
