const HINTS_TEXT = 'Arrow keys to navigate \u00B7 Enter to select \u00B7 Esc to cancel';

export class InlineEnterPlanMode {
  private containerEl: HTMLElement;
  private resolveCallback: (accepted: boolean) => void;
  private resolved = false;
  private signal?: AbortSignal;

  private rootEl!: HTMLElement;
  private focusedIndex = 0;
  private items: HTMLElement[] = [];
  private boundKeyDown: (e: KeyboardEvent) => void;
  private abortHandler: (() => void) | null = null;

  constructor(
    containerEl: HTMLElement,
    _input: Record<string, unknown>,
    resolve: (accepted: boolean) => void,
    signal?: AbortSignal,
  ) {
    this.containerEl = containerEl;
    this.resolveCallback = resolve;
    this.signal = signal;
    this.boundKeyDown = this.handleKeyDown.bind(this);
  }

  render(): void {
    this.rootEl = this.containerEl.createDiv({ cls: 'claudian-plan-mode-inline' });

    const titleEl = this.rootEl.createDiv({ cls: 'claudian-plan-inline-title' });
    titleEl.setText('Claude wants to enter plan mode');

    const descEl = this.rootEl.createDiv({ cls: 'claudian-plan-inline-desc' });
    descEl.setText('In plan mode, Claude will explore and design before executing.');

    const listEl = this.rootEl.createDiv({ cls: 'claudian-ask-list' });

    const acceptRow = listEl.createDiv({ cls: 'claudian-ask-item' });
    acceptRow.createSpan({ text: '\u203A', cls: 'claudian-ask-cursor' });
    acceptRow.createSpan({ text: '1. ', cls: 'claudian-ask-item-num' });
    acceptRow.createSpan({ text: 'Yes, enter plan mode', cls: 'claudian-ask-item-label' });
    acceptRow.addClass('is-focused');
    acceptRow.addEventListener('click', () => {
      this.focusedIndex = 0;
      this.updateFocus();
      this.handleResolve(true);
    });
    this.items.push(acceptRow);

    const declineRow = listEl.createDiv({ cls: 'claudian-ask-item' });
    declineRow.createSpan({ text: '\u00A0', cls: 'claudian-ask-cursor' });
    declineRow.createSpan({ text: '2. ', cls: 'claudian-ask-item-num' });
    declineRow.createSpan({ text: 'No, start implementing now', cls: 'claudian-ask-item-label' });
    declineRow.addEventListener('click', () => {
      this.focusedIndex = 1;
      this.updateFocus();
      this.handleResolve(false);
    });
    this.items.push(declineRow);

    this.rootEl.createDiv({ text: HINTS_TEXT, cls: 'claudian-ask-hints' });

    this.rootEl.setAttribute('tabindex', '0');
    this.rootEl.addEventListener('keydown', this.boundKeyDown);

    requestAnimationFrame(() => {
      this.rootEl.focus();
      this.rootEl.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    });

    if (this.signal) {
      this.abortHandler = () => this.handleResolve(false);
      this.signal.addEventListener('abort', this.abortHandler, { once: true });
    }
  }

  destroy(): void {
    this.handleResolve(false);
  }

  private handleKeyDown(e: KeyboardEvent): void {
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
      case 'Enter':
        e.preventDefault();
        e.stopPropagation();
        this.handleResolve(this.focusedIndex === 0);
        break;
      case 'Escape':
        e.preventDefault();
        e.stopPropagation();
        this.handleResolve(false);
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

  private handleResolve(accepted: boolean): void {
    if (!this.resolved) {
      this.resolved = true;
      this.rootEl?.removeEventListener('keydown', this.boundKeyDown);
      if (this.signal && this.abortHandler) {
        this.signal.removeEventListener('abort', this.abortHandler);
        this.abortHandler = null;
      }
      this.rootEl?.remove();
      this.resolveCallback(accepted);
    }
  }
}
