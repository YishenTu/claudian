import type { App } from 'obsidian';
import { Modal } from 'obsidian';

interface QuestionOption {
  label: string;
  description: string;
}

interface Question {
  question: string;
  header: string;
  options: QuestionOption[];
  multiSelect: boolean;
}

export class AskUserQuestionModal extends Modal {
  private input: Record<string, unknown>;
  private resolveCallback: (result: Record<string, string> | null) => void;
  private resolved = false;
  private signal?: AbortSignal;

  private questions: Question[] = [];
  private answers = new Map<number, Set<string>>();
  private customInputs = new Map<number, string>();

  private activeTabIndex = 0;
  private focusedItemIndex = 0;
  private isInputFocused = false;

  private tabBar!: HTMLElement;
  private contentArea!: HTMLElement;
  private tabElements: HTMLElement[] = [];
  private currentItems: HTMLElement[] = [];
  private boundKeyDown: (e: KeyboardEvent) => void;

  constructor(
    app: App,
    input: Record<string, unknown>,
    resolve: (result: Record<string, string> | null) => void,
    signal?: AbortSignal,
  ) {
    super(app);
    this.input = input;
    this.resolveCallback = resolve;
    this.signal = signal;
    this.boundKeyDown = this.handleKeyDown.bind(this);
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.addClass('claudian-ask-question-modal');
    this.setTitle('Claude has a question');

    this.questions = this.parseQuestions();

    if (this.questions.length === 0) {
      this.handleResolve(null);
      return;
    }

    for (let i = 0; i < this.questions.length; i++) {
      this.answers.set(i, new Set());
      this.customInputs.set(i, '');
    }

    this.tabBar = contentEl.createDiv({ cls: 'claudian-ask-tab-bar' });
    this.contentArea = contentEl.createDiv({ cls: 'claudian-ask-content' });

    this.renderTabBar();
    this.renderTabContent();

    contentEl.setAttribute('tabindex', '0');
    contentEl.addEventListener('keydown', this.boundKeyDown);
    contentEl.focus();

    if (this.signal) {
      this.signal.addEventListener('abort', () => this.handleResolve(null), { once: true });
    }
  }

  private parseQuestions(): Question[] {
    const raw = this.input.questions;
    if (!Array.isArray(raw)) return [];

    return raw
      .filter(
        (q): q is { question: string; header?: string; options: unknown[]; multiSelect?: boolean } =>
          typeof q === 'object' &&
          q !== null &&
          typeof q.question === 'string' &&
          Array.isArray(q.options),
      )
      .map((q, idx) => ({
        question: q.question,
        header: typeof q.header === 'string' ? q.header.slice(0, 12) : `Q${idx + 1}`,
        options: q.options.map((o) => this.coerceOption(o)),
        multiSelect: q.multiSelect ?? false,
      }));
  }

  private coerceOption(opt: unknown): QuestionOption {
    if (typeof opt === 'object' && opt !== null) {
      const obj = opt as Record<string, unknown>;
      const label = typeof obj.label === 'string' ? obj.label
        : typeof obj.value === 'string' ? obj.value
        : typeof obj.text === 'string' ? obj.text
        : typeof obj.name === 'string' ? obj.name
        : String(opt);
      const description = typeof obj.description === 'string' ? obj.description : '';
      return { label, description };
    }
    const text = typeof opt === 'string' ? opt : String(opt);
    return { label: text, description: '' };
  }

  // ── Tab bar ──────────────────────────────────────────

  private renderTabBar(): void {
    this.tabBar.empty();
    this.tabElements = [];

    const leftArrow = this.tabBar.createSpan({
      text: '\u2190',
      cls: 'claudian-ask-nav-arrow',
    });
    leftArrow.addEventListener('click', () => this.switchTab(this.activeTabIndex - 1));

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

    const submitTab = this.tabBar.createSpan({ cls: 'claudian-ask-tab' });
    submitTab.createSpan({ text: '\u2713 ', cls: 'claudian-ask-tab-submit-check' });
    submitTab.createSpan({ text: 'Submit', cls: 'claudian-ask-tab-label' });
    if (this.activeTabIndex === this.questions.length) submitTab.addClass('is-active');
    submitTab.addEventListener('click', () => this.switchTab(this.questions.length));
    this.tabElements.push(submitTab);

    const rightArrow = this.tabBar.createSpan({
      text: '\u2192',
      cls: 'claudian-ask-nav-arrow',
    });
    rightArrow.addEventListener('click', () => this.switchTab(this.activeTabIndex + 1));
  }

  private isQuestionAnswered(idx: number): boolean {
    const selected = this.answers.get(idx);
    const custom = this.customInputs.get(idx);
    return (
      (selected !== undefined && selected.size > 0) ||
      (custom !== undefined && custom.trim().length > 0)
    );
  }

  private switchTab(index: number): void {
    const clamped = Math.max(0, Math.min(index, this.questions.length));
    if (clamped === this.activeTabIndex) return;
    this.activeTabIndex = clamped;
    this.focusedItemIndex = 0;
    this.isInputFocused = false;
    this.renderTabBar();
    this.renderTabContent();
    this.contentEl.focus();
  }

  // ── Content rendering ────────────────────────────────

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
        row.createSpan({
          text: isSelected ? '[\u2713] ' : '[ ] ',
          cls: `claudian-ask-check${isSelected ? ' is-checked' : ''}`,
        });
      }

      const labelBlock = row.createDiv({ cls: 'claudian-ask-item-content' });
      labelBlock.createSpan({ text: option.label, cls: 'claudian-ask-item-label' });

      if (!isMulti && isSelected) {
        labelBlock.createSpan({ text: ' \u2713', cls: 'claudian-ask-check-mark' });
      }

      if (option.description) {
        labelBlock.createDiv({ text: option.description, cls: 'claudian-ask-item-desc' });
      }

      const capturedIdx = optIdx;
      row.addEventListener('click', () => {
        this.focusedItemIndex = capturedIdx;
        this.updateFocusIndicator();
        this.selectOption(idx, option.label);
      });

      this.currentItems.push(row);
    }

    // Custom input as last numbered item
    const customIdx = q.options.length;
    const customFocused = customIdx === this.focusedItemIndex;
    const customText = this.customInputs.get(idx) ?? '';

    const customRow = listEl.createDiv({ cls: 'claudian-ask-item claudian-ask-custom-item' });
    if (customFocused) customRow.addClass('is-focused');

    customRow.createSpan({ text: customFocused ? '\u203A' : '\u00A0', cls: 'claudian-ask-cursor' });
    customRow.createSpan({ text: `${customIdx + 1}. `, cls: 'claudian-ask-item-num' });

    if (isMulti) {
      customRow.createSpan({
        text: customText.trim() ? '[\u2713] ' : '[ ] ',
        cls: `claudian-ask-check${customText.trim() ? ' is-checked' : ''}`,
      });
    }

    const inputEl = customRow.createEl('input', {
      type: 'text',
      cls: 'claudian-ask-custom-text',
      placeholder: 'Type something.',
      value: customText,
    });

    inputEl.addEventListener('input', () => {
      this.customInputs.set(idx, inputEl.value);
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
      text: 'Enter to select \u00B7 Tab/Arrow keys to navigate \u00B7 Esc to cancel',
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
      text: 'Enter to select \u00B7 Tab/Arrow keys to navigate \u00B7 Esc to cancel',
      cls: 'claudian-ask-hints',
    });
  }

  // ── State helpers ────────────────────────────────────

  private getAnswerText(idx: number): string {
    const selected = this.answers.get(idx);
    const custom = this.customInputs.get(idx);
    const parts: string[] = [];
    if (selected && selected.size > 0) parts.push([...selected].join(', '));
    if (custom && custom.trim()) parts.push(custom.trim());
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
    }

    this.updateOptionVisuals(qIdx);
    this.updateTabIndicators();

    if (!isMulti) {
      setTimeout(() => this.switchTab(this.activeTabIndex + 1), 150);
    }
  }

  // ── DOM updates (no re-render) ───────────────────────

  private updateOptionVisuals(qIdx: number): void {
    const q = this.questions[qIdx];
    const selected = this.answers.get(qIdx)!;
    const isMulti = q.multiSelect;

    for (let i = 0; i < q.options.length; i++) {
      const item = this.currentItems[i];
      const isSelected = selected.has(q.options[i].label);

      if (isSelected) {
        item.addClass('is-selected');
      } else {
        item.removeClass('is-selected');
      }

      if (isMulti) {
        const checkSpan = item.querySelector('.claudian-ask-check') as HTMLElement | null;
        if (checkSpan) {
          checkSpan.textContent = isSelected ? '[\u2713] ' : '[ ] ';
          if (isSelected) checkSpan.addClass('is-checked');
          else checkSpan.removeClass('is-checked');
        }
      } else {
        const existingMark = item.querySelector('.claudian-ask-check-mark');
        if (isSelected && !existingMark) {
          item.createSpan({ text: ' \u2713', cls: 'claudian-ask-check-mark' });
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
      } else {
        item.removeClass('is-focused');
        if (cursor) cursor.textContent = '\u00A0';
      }
    }
  }

  private updateTabIndicators(): void {
    for (let idx = 0; idx < this.questions.length; idx++) {
      const tab = this.tabElements[idx];
      const tick = tab.querySelector('.claudian-ask-tab-tick');
      if (this.isQuestionAnswered(idx)) {
        tab.addClass('is-answered');
        if (tick) tick.textContent = ' \u2713';
      } else {
        tab.removeClass('is-answered');
        if (tick) tick.textContent = '';
      }
    }
  }

  // ── Keyboard ─────────────────────────────────────────

  private handleKeyDown(e: KeyboardEvent): void {
    if (this.isInputFocused) {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        this.isInputFocused = false;
        (document.activeElement as HTMLElement)?.blur();
        this.contentEl.focus();
        return;
      }
      if (e.key === 'Tab') {
        e.preventDefault();
        e.stopPropagation();
        this.isInputFocused = false;
        (document.activeElement as HTMLElement)?.blur();
        if (e.shiftKey) {
          this.switchTab(this.activeTabIndex - 1);
        } else {
          this.switchTab(this.activeTabIndex + 1);
        }
        return;
      }
      return;
    }

    // Submit tab
    if (this.activeTabIndex === this.questions.length) {
      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault();
          e.stopPropagation();
          this.focusedItemIndex = Math.min(this.focusedItemIndex + 1, 1);
          this.updateFocusIndicator();
          return;
        case 'ArrowUp':
          e.preventDefault();
          e.stopPropagation();
          this.focusedItemIndex = Math.max(this.focusedItemIndex - 1, 0);
          this.updateFocusIndicator();
          return;
        case 'ArrowLeft':
          e.preventDefault();
          e.stopPropagation();
          this.switchTab(this.activeTabIndex - 1);
          return;
        case 'Tab':
          e.preventDefault();
          e.stopPropagation();
          if (e.shiftKey) this.switchTab(this.activeTabIndex - 1);
          return;
        case 'Enter':
          e.preventDefault();
          e.stopPropagation();
          if (this.focusedItemIndex === 0) this.handleSubmit();
          else this.handleResolve(null);
          return;
        case 'Escape':
          e.preventDefault();
          this.handleResolve(null);
          return;
      }
      return;
    }

    // Question tab
    const q = this.questions[this.activeTabIndex];
    const maxIndex = q.options.length;

    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        e.stopPropagation();
        this.focusedItemIndex = Math.min(this.focusedItemIndex + 1, maxIndex);
        this.updateFocusIndicator();
        break;

      case 'ArrowUp':
        e.preventDefault();
        e.stopPropagation();
        this.focusedItemIndex = Math.max(this.focusedItemIndex - 1, 0);
        this.updateFocusIndicator();
        break;

      case 'ArrowRight':
        e.preventDefault();
        e.stopPropagation();
        this.switchTab(this.activeTabIndex + 1);
        break;

      case 'ArrowLeft':
        e.preventDefault();
        e.stopPropagation();
        this.switchTab(this.activeTabIndex - 1);
        break;

      case 'Tab':
        e.preventDefault();
        e.stopPropagation();
        if (e.shiftKey) {
          this.switchTab(this.activeTabIndex - 1);
        } else {
          this.switchTab(this.activeTabIndex + 1);
        }
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

      case 'Escape':
        e.preventDefault();
        this.handleResolve(null);
        break;
    }
  }

  // ── Submit / resolve ─────────────────────────────────

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
      this.resolveCallback(result);
      this.close();
    }
  }

  onClose() {
    this.contentEl.removeEventListener('keydown', this.boundKeyDown);
    if (!this.resolved) {
      this.resolved = true;
      this.resolveCallback(null);
    }
    this.contentEl.empty();
  }
}
