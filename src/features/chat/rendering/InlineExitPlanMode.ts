import type { ExitPlanModeDecision } from '../../../core/types/tools';

const HINTS_TEXT = 'Arrow keys to navigate \u00B7 Enter to select \u00B7 Tab for feedback \u00B7 Esc to cancel';

export class InlineExitPlanMode {
  private containerEl: HTMLElement;
  private input: Record<string, unknown>;
  private resolveCallback: (decision: ExitPlanModeDecision | null) => void;
  private resolved = false;
  private signal?: AbortSignal;

  private rootEl!: HTMLElement;
  private focusedIndex = 0;
  private items: HTMLElement[] = [];
  private feedbackInput!: HTMLInputElement;
  private isInputFocused = false;
  private boundKeyDown: (e: KeyboardEvent) => void;
  private abortHandler: (() => void) | null = null;

  constructor(
    containerEl: HTMLElement,
    input: Record<string, unknown>,
    resolve: (decision: ExitPlanModeDecision | null) => void,
    signal?: AbortSignal,
  ) {
    this.containerEl = containerEl;
    this.input = input;
    this.resolveCallback = resolve;
    this.signal = signal;
    this.boundKeyDown = this.handleKeyDown.bind(this);
  }

  render(): void {
    this.rootEl = this.containerEl.createDiv({ cls: 'claudian-plan-approval-inline' });

    const titleEl = this.rootEl.createDiv({ cls: 'claudian-plan-inline-title' });
    titleEl.setText('Plan complete');

    // Show requested permissions if available
    const allowedPrompts = this.input.allowedPrompts as Array<{ tool: string; prompt: string }> | undefined;
    if (allowedPrompts && Array.isArray(allowedPrompts) && allowedPrompts.length > 0) {
      const permEl = this.rootEl.createDiv({ cls: 'claudian-plan-permissions' });
      permEl.createDiv({ text: 'Requested permissions:', cls: 'claudian-plan-permissions-label' });
      const listEl = permEl.createEl('ul', { cls: 'claudian-plan-permissions-list' });
      for (const perm of allowedPrompts) {
        listEl.createEl('li', { text: perm.prompt });
      }
    }

    const actionsEl = this.rootEl.createDiv({ cls: 'claudian-ask-list' });

    // Approve (New Session) button — first option
    const newSessionRow = actionsEl.createDiv({ cls: 'claudian-ask-item' });
    newSessionRow.addClass('is-focused');
    newSessionRow.createSpan({ text: '\u203A', cls: 'claudian-ask-cursor' });
    newSessionRow.createSpan({ text: '1. ', cls: 'claudian-ask-item-num' });
    newSessionRow.createSpan({ text: 'Approve (new session)', cls: 'claudian-ask-item-label' });
    newSessionRow.addEventListener('click', () => {
      this.focusedIndex = 0;
      this.updateFocus();
      this.handleResolve({
        type: 'approve-new-session',
        planContent: this.extractPlanContent(),
      });
    });
    this.items.push(newSessionRow);

    // Approve (Current Session) button — second option
    const approveRow = actionsEl.createDiv({ cls: 'claudian-ask-item' });
    approveRow.createSpan({ text: '\u00A0', cls: 'claudian-ask-cursor' });
    approveRow.createSpan({ text: '2. ', cls: 'claudian-ask-item-num' });
    approveRow.createSpan({ text: 'Approve (current session)', cls: 'claudian-ask-item-label' });
    approveRow.addEventListener('click', () => {
      this.focusedIndex = 1;
      this.updateFocus();
      this.handleResolve({ type: 'approve' });
    });
    this.items.push(approveRow);

    // Feedback input row
    const feedbackRow = this.rootEl.createDiv({ cls: 'claudian-plan-feedback-row' });
    this.feedbackInput = feedbackRow.createEl('input', {
      type: 'text',
      cls: 'claudian-plan-feedback-input',
      placeholder: 'Enter feedback to continue planning...',
    });
    this.feedbackInput.addEventListener('focus', () => { this.isInputFocused = true; });
    this.feedbackInput.addEventListener('blur', () => { this.isInputFocused = false; });
    this.feedbackInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && this.feedbackInput.value.trim()) {
        e.preventDefault();
        e.stopPropagation();
        this.handleResolve({ type: 'feedback', text: this.feedbackInput.value.trim() });
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        this.isInputFocused = false;
        this.feedbackInput.blur();
        this.rootEl.focus();
      }
    });

    const sendBtn = feedbackRow.createDiv({ cls: 'claudian-plan-feedback-send', text: 'Send' });
    sendBtn.addEventListener('click', () => {
      if (this.feedbackInput.value.trim()) {
        this.handleResolve({ type: 'feedback', text: this.feedbackInput.value.trim() });
      }
    });

    this.rootEl.createDiv({ text: HINTS_TEXT, cls: 'claudian-ask-hints' });

    this.rootEl.setAttribute('tabindex', '0');
    this.rootEl.addEventListener('keydown', this.boundKeyDown);

    requestAnimationFrame(() => {
      this.rootEl.focus();
      this.rootEl.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    });

    if (this.signal) {
      this.abortHandler = () => this.handleResolve(null);
      this.signal.addEventListener('abort', this.abortHandler, { once: true });
    }
  }

  destroy(): void {
    this.handleResolve(null);
  }

  private extractPlanContent(): string {
    const planFilePath = this.input.planFilePath as string | undefined;
    if (planFilePath) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const fs = require('fs');
        const content = fs.readFileSync(planFilePath, 'utf-8') as string;
        if (content.trim()) {
          return `Implement this plan:\n\n${content}`;
        }
      } catch {
        // Fall through if file can't be read
      }
    }
    return 'Implement the approved plan.';
  }

  private handleKeyDown(e: KeyboardEvent): void {
    if (this.isInputFocused) {
      // Only handle escape when input is focused (Enter handled in input listener)
      return;
    }

    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        e.stopPropagation();
        this.focusedIndex = Math.min(this.focusedIndex + 1, 1);
        this.updateFocus();
        break;
      case 'ArrowUp':
        e.preventDefault();
        e.stopPropagation();
        this.focusedIndex = Math.max(this.focusedIndex - 1, 0);
        this.updateFocus();
        break;
      case 'Tab':
        e.preventDefault();
        e.stopPropagation();
        this.feedbackInput.focus();
        break;
      case 'Enter':
        e.preventDefault();
        e.stopPropagation();
        if (this.focusedIndex === 0) {
          this.handleResolve({
            type: 'approve-new-session',
            planContent: this.extractPlanContent(),
          });
        } else {
          this.handleResolve({ type: 'approve' });
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
      } else {
        item.removeClass('is-focused');
        if (cursor) cursor.textContent = '\u00A0';
      }
    }
  }

  private handleResolve(decision: ExitPlanModeDecision | null): void {
    if (!this.resolved) {
      this.resolved = true;
      this.rootEl?.removeEventListener('keydown', this.boundKeyDown);
      if (this.signal && this.abortHandler) {
        this.signal.removeEventListener('abort', this.abortHandler);
        this.abortHandler = null;
      }
      this.rootEl?.remove();
      this.resolveCallback(decision);
    }
  }
}
