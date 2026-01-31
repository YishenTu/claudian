import type { ExitPlanModeDecision } from '../../../core/types/tools';
import type { RenderContentFn } from './MessageRenderer';

const HINTS_TEXT = 'Arrow keys to navigate \u00B7 Enter to select \u00B7 Esc to cancel';

export class InlineExitPlanMode {
  private containerEl: HTMLElement;
  private input: Record<string, unknown>;
  private resolveCallback: (decision: ExitPlanModeDecision | null) => void;
  private resolved = false;
  private signal?: AbortSignal;
  private renderContent?: RenderContentFn;
  private planContent: string | null = null;

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
    renderContent?: RenderContentFn,
  ) {
    this.containerEl = containerEl;
    this.input = input;
    this.resolveCallback = resolve;
    this.signal = signal;
    this.renderContent = renderContent;
    this.boundKeyDown = this.handleKeyDown.bind(this);
  }

  render(): void {
    this.rootEl = this.containerEl.createDiv({ cls: 'claudian-plan-approval-inline' });

    const titleEl = this.rootEl.createDiv({ cls: 'claudian-plan-inline-title' });
    titleEl.setText('Plan complete');

    this.planContent = this.readPlanContent();
    if (this.planContent) {
      const contentEl = this.rootEl.createDiv({ cls: 'claudian-plan-content-preview' });
      if (this.renderContent) {
        void this.renderContent(contentEl, this.planContent);
      } else {
        contentEl.createDiv({ cls: 'claudian-plan-content-text', text: this.planContent });
      }
    }

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

    const feedbackRow = actionsEl.createDiv({ cls: 'claudian-ask-item claudian-ask-custom-item' });
    feedbackRow.createSpan({ text: '\u00A0', cls: 'claudian-ask-cursor' });
    feedbackRow.createSpan({ text: '3. ', cls: 'claudian-ask-item-num' });
    this.feedbackInput = feedbackRow.createEl('input', {
      type: 'text',
      cls: 'claudian-ask-custom-text',
      placeholder: 'Enter feedback to continue planning...',
    });
    this.feedbackInput.addEventListener('focus', () => { this.isInputFocused = true; });
    this.feedbackInput.addEventListener('blur', () => { this.isInputFocused = false; });
    feedbackRow.addEventListener('click', () => {
      this.focusedIndex = 2;
      this.updateFocus();
    });
    this.items.push(feedbackRow);

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

  private readPlanContent(): string | null {
    const planFilePath = this.input.planFilePath as string | undefined;
    if (!planFilePath) return null;
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const fs = require('fs');
      const content = fs.readFileSync(planFilePath, 'utf-8') as string;
      return content.trim() || null;
    } catch {
      return null;
    }
  }

  private extractPlanContent(): string {
    if (this.planContent) {
      return `Implement this plan:\n\n${this.planContent}`;
    }
    return 'Implement the approved plan.';
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
        this.handleResolve({ type: 'feedback', text: this.feedbackInput.value.trim() });
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
          this.handleResolve({
            type: 'approve-new-session',
            planContent: this.extractPlanContent(),
          });
        } else if (this.focusedIndex === 1) {
          this.handleResolve({ type: 'approve' });
        } else if (this.focusedIndex === 2) {
          this.feedbackInput.focus();
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

        if (item.hasClass('claudian-ask-custom-item')) {
          const input = item.querySelector('.claudian-ask-custom-text') as HTMLInputElement;
          if (input && document.activeElement === input) {
            input.blur();
            this.isInputFocused = false;
          }
        }
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
