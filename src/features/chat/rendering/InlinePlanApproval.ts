export type PlanApprovalDecision =
  | { type: 'implement' }
  | { type: 'revise'; text: string }
  | { type: 'cancel' };

const HINTS_TEXT = 'Arrow keys to navigate \u00B7 Enter to select \u00B7 Esc to cancel';

export class InlinePlanApproval {
  private containerEl: HTMLElement;
  private resolveCallback: (decision: PlanApprovalDecision | null) => void;
  private resolved = false;

  private rootEl!: HTMLElement;
  private focusedIndex = 0;
  private items: HTMLElement[] = [];
  private feedbackInput!: HTMLInputElement;
  private isInputFocused = false;
  private boundKeyDown: (e: KeyboardEvent) => void;

  constructor(
    containerEl: HTMLElement,
    resolve: (decision: PlanApprovalDecision | null) => void,
  ) {
    this.containerEl = containerEl;
    this.resolveCallback = resolve;
    this.boundKeyDown = this.handleKeyDown.bind(this);
  }

  render(): void {
    this.rootEl = this.containerEl.createDiv({ cls: 'claudian-plan-approval-inline' });

    this.rootEl.createDiv({ cls: 'claudian-plan-inline-title', text: 'Plan complete' });

    const actionsEl = this.rootEl.createDiv({ cls: 'claudian-ask-list' });

    // 1. Implement
    const implementRow = actionsEl.createDiv({ cls: 'claudian-ask-item' });
    implementRow.addClass('is-focused');
    implementRow.createSpan({ text: '\u203A', cls: 'claudian-ask-cursor' });
    implementRow.createSpan({ text: '1. ', cls: 'claudian-ask-item-num' });
    implementRow.createSpan({ text: 'Implement', cls: 'claudian-ask-item-label' });
    implementRow.addEventListener('click', () => {
      this.focusedIndex = 0;
      this.updateFocus();
      this.handleResolve({ type: 'implement' });
    });
    this.items.push(implementRow);

    // 2. Revise (with feedback input)
    const reviseRow = actionsEl.createDiv({ cls: 'claudian-ask-item claudian-ask-custom-item' });
    reviseRow.createSpan({ text: '\u00A0', cls: 'claudian-ask-cursor' });
    reviseRow.createSpan({ text: '2. ', cls: 'claudian-ask-item-num' });
    this.feedbackInput = reviseRow.createEl('input', {
      type: 'text',
      cls: 'claudian-ask-custom-text',
      placeholder: 'Enter feedback to revise plan...',
    });
    this.feedbackInput.addEventListener('focus', () => { this.isInputFocused = true; });
    this.feedbackInput.addEventListener('blur', () => { this.isInputFocused = false; });
    reviseRow.addEventListener('click', () => {
      this.focusedIndex = 1;
      this.updateFocus();
    });
    this.items.push(reviseRow);

    // 3. Cancel
    const cancelRow = actionsEl.createDiv({ cls: 'claudian-ask-item' });
    cancelRow.createSpan({ text: '\u00A0', cls: 'claudian-ask-cursor' });
    cancelRow.createSpan({ text: '3. ', cls: 'claudian-ask-item-num' });
    cancelRow.createSpan({ text: 'Cancel', cls: 'claudian-ask-item-label' });
    cancelRow.addEventListener('click', () => {
      this.focusedIndex = 2;
      this.updateFocus();
      this.handleResolve({ type: 'cancel' });
    });
    this.items.push(cancelRow);

    this.rootEl.createDiv({ text: HINTS_TEXT, cls: 'claudian-ask-hints' });

    this.rootEl.setAttribute('tabindex', '0');
    this.rootEl.addEventListener('keydown', this.boundKeyDown);

    const ownerWindow = this.rootEl.ownerDocument.defaultView ?? window;
    ownerWindow.requestAnimationFrame(() => {
      this.rootEl.focus();
      this.rootEl.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    });
  }

  destroy(): void {
    this.handleResolve(null);
  }

  private handleKeyDown(e: KeyboardEvent): void {
    if (this.isInputFocused) {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        this.isInputFocused = false;
        this.feedbackInput.blur();
        this.rootEl.focus();
        return;
      }
      if (e.key === 'Enter' && this.feedbackInput.value.trim()) {
        e.preventDefault();
        e.stopPropagation();
        this.handleResolve({ type: 'revise', text: this.feedbackInput.value.trim() });
        return;
      }
      return;
    }

    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        e.stopPropagation();
        this.focusedIndex = Math.min(this.focusedIndex + 1, this.items.length - 1);
        this.updateFocus();
        break;
      case 'ArrowUp':
        e.preventDefault();
        e.stopPropagation();
        this.focusedIndex = Math.max(this.focusedIndex - 1, 0);
        this.updateFocus();
        break;
      case 'Enter':
        e.preventDefault();
        e.stopPropagation();
        if (this.focusedIndex === 0) {
          this.handleResolve({ type: 'implement' });
        } else if (this.focusedIndex === 1) {
          this.feedbackInput.focus();
        } else if (this.focusedIndex === 2) {
          this.handleResolve({ type: 'cancel' });
        }
        break;
      case 'Escape':
        e.preventDefault();
        e.stopPropagation();
        this.handleResolve(null);
        break;
    }
  }

  private updateFocus(): void {
    for (let i = 0; i < this.items.length; i++) {
      const item = this.items[i];
      const cursor = item.querySelector('.claudian-ask-cursor');
      if (i === this.focusedIndex) {
        item.addClass('is-focused');
        if (cursor) cursor.textContent = '\u203A';
        item.scrollIntoView({ block: 'nearest' });

        if (item.hasClass('claudian-ask-custom-item')) {
          const input = item.querySelector('.claudian-ask-custom-text') as HTMLInputElement;
          if (input) {
            input.focus();
            this.isInputFocused = true;
          }
        }
      } else {
        item.removeClass('is-focused');
        if (cursor) cursor.textContent = '\u00A0';

        if (item.hasClass('claudian-ask-custom-item') && this.isInputFocused) {
          const input = item.querySelector('.claudian-ask-custom-text') as HTMLInputElement;
          if (input) {
            input.blur();
            this.isInputFocused = false;
          }
        }
      }
    }
  }

  private handleResolve(decision: PlanApprovalDecision | null): void {
    if (!this.resolved) {
      this.resolved = true;
      this.rootEl?.removeEventListener('keydown', this.boundKeyDown);
      this.rootEl?.remove();
      this.resolveCallback(decision);
    }
  }
}
