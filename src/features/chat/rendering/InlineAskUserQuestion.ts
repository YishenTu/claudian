import type { AskUserQuestionItem, AskUserQuestionOption } from '../../../core/types/tools';

const HINTS_TEXT = 'Enter to select \u00B7 Tab/Arrow keys to navigate \u00B7 Esc to cancel';

export class InlineAskUserQuestion {
  private containerEl: HTMLElement;
  private input: Record<string, unknown>;
  private resolveCallback: (result: Record<string, string> | null) => void;
  private resolved = false;
  private signal?: AbortSignal;

  private questions: AskUserQuestionItem[] = [];
  private answers = new Map<number, Set<string>>();
  private customInputs = new Map<number, string>();

  private activeTabIndex = 0;
  private focusedItemIndex = 0;
  private isInputFocused = false;

  private rootEl!: HTMLElement;
  private tabBar!: HTMLElement;
  private contentArea!: HTMLElement;
  private tabElements: HTMLElement[] = [];
  private currentItems: HTMLElement[] = [];
  private boundKeyDown: (e: KeyboardEvent) => void;
  private abortHandler: (() => void) | null = null;

  constructor(
    containerEl: HTMLElement,
    input: Record<string, unknown>,
    resolve: (result: Record<string, string> | null) => void,
    signal?: AbortSignal,
  ) {
    this.containerEl = containerEl;
    this.input = input;
    this.resolveCallback = resolve;
    this.signal = signal;
    this.boundKeyDown = this.handleKeyDown.bind(this);
  }

  render(): void {
    this.rootEl = this.containerEl.createDiv({ cls: 'claudian-ask-question-inline' });

    const titleEl = this.rootEl.createDiv({ cls: 'claudian-ask-inline-title' });
    titleEl.setText('Claude has a question');

    this.questions = this.parseQuestions();

    if (this.questions.length === 0) {
      this.handleResolve(null);
      return;
    }

    for (let i = 0; i < this.questions.length; i++) {
      this.answers.set(i, new Set());
      this.customInputs.set(i, '');
    }

    this.tabBar = this.rootEl.createDiv({ cls: 'claudian-ask-tab-bar' });
    this.contentArea = this.rootEl.createDiv({ cls: 'claudian-ask-content' });

    this.renderTabBar();
    this.renderTabContent();

    this.rootEl.setAttribute('tabindex', '0');
    this.rootEl.addEventListener('keydown', this.boundKeyDown);

    // Defer focus to after the element is in the DOM and laid out
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

  private parseQuestions(): AskUserQuestionItem[] {
    const raw = this.input.questions;
    if (!Array.isArray(raw)) return [];

    return raw
      .filter(
        (q): q is { question: string; header?: string; options: unknown[]; multiSelect?: boolean } =>
          typeof q === 'object' &&
          q !== null &&
          typeof q.question === 'string' &&
          Array.isArray(q.options) &&
          q.options.length > 0,
      )
      .map((q, idx) => ({
        question: q.question,
        header: typeof q.header === 'string' ? q.header.slice(0, 12) : `Q${idx + 1}`,
        options: this.deduplicateOptions(q.options.map((o) => this.coerceOption(o))),
        multiSelect: q.multiSelect ?? false,
      }));
  }

  private coerceOption(opt: unknown): AskUserQuestionOption {
    if (typeof opt === 'object' && opt !== null) {
      const obj = opt as Record<string, unknown>;
      const label = this.extractLabel(obj);
      const description = typeof obj.description === 'string' ? obj.description : '';
      return { label, description };
    }
    return { label: typeof opt === 'string' ? opt : String(opt), description: '' };
  }

  private deduplicateOptions(options: AskUserQuestionOption[]): AskUserQuestionOption[] {
    const seen = new Set<string>();
    return options.filter((o) => {
      if (seen.has(o.label)) return false;
      seen.add(o.label);
      return true;
    });
  }

  private extractLabel(obj: Record<string, unknown>): string {
    if (typeof obj.label === 'string') return obj.label;
    if (typeof obj.value === 'string') return obj.value;
    if (typeof obj.text === 'string') return obj.text;
    if (typeof obj.name === 'string') return obj.name;
    return String(obj);
  }

  private renderTabBar(): void {
    this.tabBar.empty();
    this.tabElements = [];

    for (let idx = 0; idx < this.questions.length; idx++) {
      const answered = this.isQuestionAnswered(idx);
      const tab = this.tabBar.createSpan({ cls: 'claudian-ask-tab' });
      tab.createSpan({ text: this.questions[idx].header, cls: 'claudian-ask-tab-label' });
      tab.createSpan({ text: answered ? ' \u2713' : '', cls: 'claudian-ask-tab-tick' });
      tab.setAttribute('title', this.questions[idx].question);

      if (idx === this.activeTabIndex) tab.addClass('is-active');
      if (answered) tab.addClass('is-answered');
      tab.addEventListener('click', () => this.switchTab(idx));
      this.tabElements.push(tab);
    }

    const allAnswered = this.questions.every((_, i) => this.isQuestionAnswered(i));
    const submitTab = this.tabBar.createSpan({ cls: 'claudian-ask-tab' });
    submitTab.createSpan({ text: allAnswered ? '\u2713 ' : '', cls: 'claudian-ask-tab-submit-check' });
    submitTab.createSpan({ text: 'Submit', cls: 'claudian-ask-tab-label' });
    if (this.activeTabIndex === this.questions.length) submitTab.addClass('is-active');
    submitTab.addEventListener('click', () => this.switchTab(this.questions.length));
    this.tabElements.push(submitTab);
  }

  private isQuestionAnswered(idx: number): boolean {
    return this.answers.get(idx)!.size > 0 || this.customInputs.get(idx)!.trim().length > 0;
  }

  private switchTab(index: number): void {
    const clamped = Math.max(0, Math.min(index, this.questions.length));
    if (clamped === this.activeTabIndex) return;
    this.activeTabIndex = clamped;
    this.focusedItemIndex = 0;
    this.isInputFocused = false;
    this.renderTabBar();
    this.renderTabContent();
    this.rootEl.focus();
  }

  private renderTabContent(): void {
    this.contentArea.empty();
    this.currentItems = [];

    if (this.activeTabIndex < this.questions.length) {
      this.renderQuestionTab(this.activeTabIndex);
    } else {
      this.renderSubmitTab();
    }
  }

  private renderQuestionTab(idx: number): void {
    const q = this.questions[idx];
    const isMulti = q.multiSelect;
    const selected = this.answers.get(idx)!;

    this.contentArea.createDiv({
      text: q.question,
      cls: 'claudian-ask-question-text',
    });

    const listEl = this.contentArea.createDiv({ cls: 'claudian-ask-list' });

    for (let optIdx = 0; optIdx < q.options.length; optIdx++) {
      const option = q.options[optIdx];
      const isFocused = optIdx === this.focusedItemIndex;
      const isSelected = selected.has(option.label);

      const row = listEl.createDiv({ cls: 'claudian-ask-item' });
      if (isFocused) row.addClass('is-focused');
      if (isSelected) row.addClass('is-selected');

      row.createSpan({ text: isFocused ? '\u203A' : '\u00A0', cls: 'claudian-ask-cursor' });
      row.createSpan({ text: `${optIdx + 1}. `, cls: 'claudian-ask-item-num' });

      if (isMulti) {
        this.renderMultiSelectCheckbox(row, isSelected);
      }

      const labelBlock = row.createDiv({ cls: 'claudian-ask-item-content' });
      const labelRow = labelBlock.createDiv({ cls: 'claudian-ask-label-row' });
      labelRow.createSpan({ text: option.label, cls: 'claudian-ask-item-label' });

      if (!isMulti && isSelected) {
        labelRow.createSpan({ text: ' \u2713', cls: 'claudian-ask-check-mark' });
      }

      if (option.description) {
        labelBlock.createDiv({ text: option.description, cls: 'claudian-ask-item-desc' });
      }

      row.addEventListener('click', () => {
        this.focusedItemIndex = optIdx;
        this.updateFocusIndicator();
        this.selectOption(idx, option.label);
      });

      this.currentItems.push(row);
    }

    const customIdx = q.options.length;
    const customFocused = customIdx === this.focusedItemIndex;
    const customText = this.customInputs.get(idx) ?? '';
    const hasCustomText = customText.trim().length > 0;

    const customRow = listEl.createDiv({ cls: 'claudian-ask-item claudian-ask-custom-item' });
    if (customFocused) customRow.addClass('is-focused');

    customRow.createSpan({ text: customFocused ? '\u203A' : '\u00A0', cls: 'claudian-ask-cursor' });
    customRow.createSpan({ text: `${customIdx + 1}. `, cls: 'claudian-ask-item-num' });

    if (isMulti) {
      this.renderMultiSelectCheckbox(customRow, hasCustomText);
    }

    const inputEl = customRow.createEl('input', {
      type: 'text',
      cls: 'claudian-ask-custom-text',
      placeholder: 'Type something.',
      value: customText,
    });

    inputEl.addEventListener('input', () => {
      this.customInputs.set(idx, inputEl.value);
      if (!isMulti && inputEl.value.trim()) {
        selected.clear();
        this.updateOptionVisuals(idx);
      }
      this.updateTabIndicators();
    });
    inputEl.addEventListener('focus', () => {
      this.isInputFocused = true;
    });
    inputEl.addEventListener('blur', () => {
      this.isInputFocused = false;
    });

    this.currentItems.push(customRow);

    this.contentArea.createDiv({
      text: HINTS_TEXT,
      cls: 'claudian-ask-hints',
    });
  }

  private renderSubmitTab(): void {
    this.contentArea.createDiv({
      text: 'Review your answers',
      cls: 'claudian-ask-review-title',
    });

    const reviewEl = this.contentArea.createDiv({ cls: 'claudian-ask-review' });

    for (let idx = 0; idx < this.questions.length; idx++) {
      const q = this.questions[idx];
      const answerText = this.getAnswerText(idx);

      const qLine = reviewEl.createDiv({ cls: 'claudian-ask-review-q' });
      qLine.createSpan({ text: '\u25CF ', cls: 'claudian-ask-review-bullet' });
      qLine.createSpan({ text: q.question, cls: 'claudian-ask-review-q-text' });
      qLine.addEventListener('click', () => this.switchTab(idx));

      const aLine = reviewEl.createDiv({ cls: 'claudian-ask-review-a' });
      aLine.createSpan({ text: '  \u2192 ', cls: 'claudian-ask-review-arrow' });
      aLine.createSpan({
        text: answerText || 'Not answered',
        cls: answerText ? 'claudian-ask-review-a-text' : 'claudian-ask-review-empty',
      });
      aLine.addEventListener('click', () => this.switchTab(idx));
    }

    this.contentArea.createDiv({
      text: 'Ready to submit your answers?',
      cls: 'claudian-ask-review-prompt',
    });

    const actionsEl = this.contentArea.createDiv({ cls: 'claudian-ask-list' });
    const allAnswered = this.questions.every((_, i) => this.isQuestionAnswered(i));

    const submitRow = actionsEl.createDiv({ cls: 'claudian-ask-item' });
    if (this.focusedItemIndex === 0) submitRow.addClass('is-focused');
    if (!allAnswered) submitRow.addClass('is-disabled');
    submitRow.createSpan({ text: this.focusedItemIndex === 0 ? '\u203A' : '\u00A0', cls: 'claudian-ask-cursor' });
    submitRow.createSpan({ text: '1. ', cls: 'claudian-ask-item-num' });
    submitRow.createSpan({ text: 'Submit answers', cls: 'claudian-ask-item-label' });
    submitRow.addEventListener('click', () => {
      this.focusedItemIndex = 0;
      this.updateFocusIndicator();
      this.handleSubmit();
    });
    this.currentItems.push(submitRow);

    const cancelRow = actionsEl.createDiv({ cls: 'claudian-ask-item' });
    if (this.focusedItemIndex === 1) cancelRow.addClass('is-focused');
    cancelRow.createSpan({ text: this.focusedItemIndex === 1 ? '\u203A' : '\u00A0', cls: 'claudian-ask-cursor' });
    cancelRow.createSpan({ text: '2. ', cls: 'claudian-ask-item-num' });
    cancelRow.createSpan({ text: 'Cancel', cls: 'claudian-ask-item-label' });
    cancelRow.addEventListener('click', () => {
      this.focusedItemIndex = 1;
      this.handleResolve(null);
    });
    this.currentItems.push(cancelRow);

    this.contentArea.createDiv({
      text: HINTS_TEXT,
      cls: 'claudian-ask-hints',
    });
  }

  private getAnswerText(idx: number): string {
    const selected = this.answers.get(idx)!;
    const custom = this.customInputs.get(idx)!;
    const parts: string[] = [];
    if (selected.size > 0) parts.push([...selected].join(', '));
    if (custom.trim()) parts.push(custom.trim());
    return parts.join(', ');
  }

  private selectOption(qIdx: number, label: string): void {
    const q = this.questions[qIdx];
    const selected = this.answers.get(qIdx)!;
    const isMulti = q.multiSelect;

    if (isMulti) {
      if (selected.has(label)) {
        selected.delete(label);
      } else {
        selected.add(label);
      }
    } else {
      selected.clear();
      selected.add(label);
      this.customInputs.set(qIdx, '');
    }

    this.updateOptionVisuals(qIdx);
    this.updateTabIndicators();

    if (!isMulti) {
      this.switchTab(this.activeTabIndex + 1);
    }
  }

  private renderMultiSelectCheckbox(parent: HTMLElement, checked: boolean): void {
    parent.createSpan({
      text: checked ? '[\u2713] ' : '[ ] ',
      cls: `claudian-ask-check${checked ? ' is-checked' : ''}`,
    });
  }

  private updateOptionVisuals(qIdx: number): void {
    const q = this.questions[qIdx];
    const selected = this.answers.get(qIdx)!;
    const isMulti = q.multiSelect;

    for (let i = 0; i < q.options.length; i++) {
      const item = this.currentItems[i];
      const isSelected = selected.has(q.options[i].label);

      item.toggleClass('is-selected', isSelected);

      if (isMulti) {
        const checkSpan = item.querySelector('.claudian-ask-check') as HTMLElement | null;
        if (checkSpan) {
          checkSpan.textContent = isSelected ? '[\u2713] ' : '[ ] ';
          checkSpan.toggleClass('is-checked', isSelected);
        }
      } else {
        const labelRow = item.querySelector('.claudian-ask-label-row') as HTMLElement | null;
        const existingMark = item.querySelector('.claudian-ask-check-mark');
        if (isSelected && !existingMark && labelRow) {
          labelRow.createSpan({ text: ' \u2713', cls: 'claudian-ask-check-mark' });
        } else if (!isSelected && existingMark) {
          existingMark.remove();
        }
      }
    }
  }

  private updateFocusIndicator(): void {
    for (let i = 0; i < this.currentItems.length; i++) {
      const item = this.currentItems[i];
      const cursor = item.querySelector('.claudian-ask-cursor');
      if (i === this.focusedItemIndex) {
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

  private updateTabIndicators(): void {
    for (let idx = 0; idx < this.questions.length; idx++) {
      const tab = this.tabElements[idx];
      const tick = tab.querySelector('.claudian-ask-tab-tick');
      const answered = this.isQuestionAnswered(idx);
      tab.toggleClass('is-answered', answered);
      if (tick) tick.textContent = answered ? ' \u2713' : '';
    }
    const submitTab = this.tabElements[this.questions.length];
    if (submitTab) {
      const submitCheck = submitTab.querySelector('.claudian-ask-tab-submit-check');
      const allAnswered = this.questions.every((_, i) => this.isQuestionAnswered(i));
      if (submitCheck) submitCheck.textContent = allAnswered ? '\u2713 ' : '';
    }
  }

  private handleNavigationKey(e: KeyboardEvent, maxFocusIndex: number): boolean {
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        e.stopPropagation();
        this.focusedItemIndex = Math.min(this.focusedItemIndex + 1, maxFocusIndex);
        this.updateFocusIndicator();
        return true;
      case 'ArrowUp':
        e.preventDefault();
        e.stopPropagation();
        this.focusedItemIndex = Math.max(this.focusedItemIndex - 1, 0);
        this.updateFocusIndicator();
        return true;
      case 'ArrowLeft':
        e.preventDefault();
        e.stopPropagation();
        this.switchTab(this.activeTabIndex - 1);
        return true;
      case 'Tab':
        e.preventDefault();
        e.stopPropagation();
        if (e.shiftKey) {
          this.switchTab(this.activeTabIndex - 1);
        } else {
          this.switchTab(this.activeTabIndex + 1);
        }
        return true;
      case 'Escape':
        e.preventDefault();
        e.stopPropagation();
        this.handleResolve(null);
        return true;
      default:
        return false;
    }
  }

  private handleKeyDown(e: KeyboardEvent): void {
    if (this.isInputFocused) {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        this.isInputFocused = false;
        (document.activeElement as HTMLElement)?.blur();
        this.rootEl.focus();
        return;
      }
      if (e.key === 'Tab' || e.key === 'Enter') {
        e.preventDefault();
        e.stopPropagation();
        this.isInputFocused = false;
        (document.activeElement as HTMLElement)?.blur();
        if (e.key === 'Tab' && e.shiftKey) {
          this.switchTab(this.activeTabIndex - 1);
        } else {
          this.switchTab(this.activeTabIndex + 1);
        }
        return;
      }
      return;
    }

    const isSubmitTab = this.activeTabIndex === this.questions.length;
    const maxFocusIndex = isSubmitTab
      ? 1
      : this.questions[this.activeTabIndex].options.length;

    if (this.handleNavigationKey(e, maxFocusIndex)) return;

    if (isSubmitTab) {
      if (e.key === 'Enter') {
        e.preventDefault();
        e.stopPropagation();
        if (this.focusedItemIndex === 0) this.handleSubmit();
        else this.handleResolve(null);
      }
      return;
    }

    // Question tab: ArrowRight and Enter
    const q = this.questions[this.activeTabIndex];
    switch (e.key) {
      case 'ArrowRight':
        e.preventDefault();
        e.stopPropagation();
        this.switchTab(this.activeTabIndex + 1);
        break;
      case 'Enter':
        e.preventDefault();
        e.stopPropagation();
        if (this.focusedItemIndex < q.options.length) {
          this.selectOption(this.activeTabIndex, q.options[this.focusedItemIndex].label);
        } else {
          this.isInputFocused = true;
          const input = this.contentArea.querySelector(
            '.claudian-ask-custom-text',
          ) as HTMLInputElement;
          input?.focus();
        }
        break;
    }
  }

  private handleSubmit(): void {
    const allAnswered = this.questions.every((_, i) => this.isQuestionAnswered(i));
    if (!allAnswered) return;

    const result: Record<string, string> = {};
    for (let i = 0; i < this.questions.length; i++) {
      result[this.questions[i].question] = this.getAnswerText(i);
    }
    this.handleResolve(result);
  }

  private handleResolve(result: Record<string, string> | null): void {
    if (!this.resolved) {
      this.resolved = true;
      this.rootEl?.removeEventListener('keydown', this.boundKeyDown);
      if (this.signal && this.abortHandler) {
        this.signal.removeEventListener('abort', this.abortHandler);
        this.abortHandler = null;
      }
      this.rootEl?.remove();
      this.resolveCallback(result);
    }
  }
}
