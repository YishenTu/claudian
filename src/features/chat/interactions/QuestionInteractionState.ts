/** Mutable answer and delivery state shared by successive views of one pending request. */
export class QuestionInteractionState {
  resolved = false;
  submitting = false;
  submissionError = '';
  readonly answers = new Map<number, Set<string>>();
  readonly customInputs = new Map<number, string>();
  activeTabIndex = 0;
  onChange?: () => void;
}
