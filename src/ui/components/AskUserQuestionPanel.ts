/**
 * AskUserQuestion panel component - minimal design.
 *
 * Replaces the input area while waiting for user response to questions.
 */

import type { App } from 'obsidian';

import type { AskUserQuestionInput, AskUserQuestionQuestion } from '../../core/types';

/** Result from the panel. */
export interface AskUserQuestionPanelResult {
  answers: Record<string, string | string[]>;
}

/** Options for creating the panel. */
export interface AskUserQuestionPanelOptions {
  /** Container element (the main claudian view container). */
  containerEl: HTMLElement;
  /** The questions to display. */
  input: AskUserQuestionInput;
  /** Callback when user submits answers. */
  onSubmit: (answers: Record<string, string | string[]>) => void;
  /** Callback when user cancels (Escape). */
  onCancel: () => void;
}

/** Find the input container and wrapper elements. */
function findInputElements(containerEl: HTMLElement): {
  inputContainer: HTMLElement | null;
  inputWrapper: HTMLElement | null;
} {
  const inputContainer = containerEl.querySelector('.claudian-input-container') as HTMLElement | null;
  const inputWrapper = containerEl.querySelector('.claudian-input-wrapper') as HTMLElement | null;
  return { inputContainer, inputWrapper };
}

/**
 * AskUserQuestion panel - minimal design.
 */
export class AskUserQuestionPanel {
  private app: App;
  private containerEl: HTMLElement;
  private panelEl: HTMLElement;
  private questions: AskUserQuestionQuestion[];
  private answers: Map<string, string | string[]> = new Map();
  private currentTabIndex = 0;
  private currentOptionIndex = 0;
  private onSubmit: (answers: Record<string, string | string[]>) => void;
  private onCancel: () => void;
  private isDestroyed = false;
  private documentKeydownHandler: ((e: KeyboardEvent) => void) | null = null;

  // DOM references
  private tabsEl: HTMLElement | null = null;
  private questionContentEl: HTMLElement | null = null;
  private otherInputEl: HTMLInputElement | null = null;

  // Input area references (for hiding/showing)
  private inputContainer: HTMLElement | null = null;
  private inputWrapper: HTMLElement | null = null;

  constructor(app: App, options: AskUserQuestionPanelOptions) {
    this.app = app;
    this.containerEl = options.containerEl;
    this.questions = options.input.questions;
    this.onSubmit = options.onSubmit;
    this.onCancel = options.onCancel;

    // Find and hide the input area
    const { inputContainer, inputWrapper } = findInputElements(this.containerEl);
    this.inputContainer = inputContainer;
    this.inputWrapper = inputWrapper;

    if (this.inputWrapper) {
      this.inputWrapper.style.display = 'none';
    }

    // Create panel and insert it where the input wrapper was
    this.panelEl = this.createPanel();
    if (this.inputContainer) {
      this.inputContainer.appendChild(this.panelEl);
    } else {
      this.containerEl.appendChild(this.panelEl);
    }

    // Focus the panel
    this.panelEl.focus();

    this.attachDocumentHandler();
  }

  /** Create the panel DOM structure. */
  private createPanel(): HTMLElement {
    const panel = document.createElement('div');
    panel.className = 'claudian-ask-panel';
    panel.setAttribute('tabindex', '0');
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', 'Claude is asking a question');

    // Add keyboard listener
    panel.addEventListener('keydown', this.handleKeyDown.bind(this));

    // Create tabs row (always show, even for single question)
    this.tabsEl = this.createTabs(panel);

    // Question content area
    this.questionContentEl = document.createElement('div');
    this.questionContentEl.className = 'claudian-ask-panel-content';
    panel.appendChild(this.questionContentEl);

    // Hint text
    const hintEl = document.createElement('div');
    hintEl.className = 'claudian-ask-panel-hint';
    hintEl.textContent = 'Enter to select · Tab/Arrow keys to navigate · Esc to cancel';
    panel.appendChild(hintEl);

    // Render first content
    this.renderCurrentContent();

    return panel;
  }

  /** Create tab navigation row. */
  private createTabs(parent: HTMLElement): HTMLElement {
    const tabsContainer = document.createElement('div');
    tabsContainer.className = 'claudian-ask-panel-tabs';

    // Left arrow
    const leftArrow = document.createElement('span');
    leftArrow.className = 'claudian-ask-panel-nav';
    leftArrow.textContent = '←';
    leftArrow.addEventListener('click', () => this.navigateTab(-1));
    tabsContainer.appendChild(leftArrow);

    // Question tabs
    this.questions.forEach((q, index) => {
      const tab = document.createElement('button');
      tab.className = 'claudian-ask-panel-tab';
      tab.setAttribute('data-tab-index', String(index));

      // Status indicator (○ unanswered, ● answered)
      const check = document.createElement('span');
      check.className = 'claudian-ask-panel-tab-check';
      check.textContent = '○';
      tab.appendChild(check);

      // Label
      const label = document.createTextNode(` ${q.header || `Q${index + 1}`}`);
      tab.appendChild(label);

      if (index === 0) {
        tab.classList.add('active');
      }

      tab.addEventListener('click', () => this.switchToTab(index));
      tabsContainer.appendChild(tab);
    });

    // Submit tab (as a proper tab)
    const submitTab = document.createElement('button');
    submitTab.className = 'claudian-ask-panel-tab claudian-ask-panel-submit-tab';
    submitTab.setAttribute('data-tab-index', String(this.questions.length));

    const submitCheck = document.createElement('span');
    submitCheck.className = 'claudian-ask-panel-tab-check';
    submitCheck.textContent = '✓';
    submitTab.appendChild(submitCheck);

    const submitLabel = document.createTextNode(' Submit');
    submitTab.appendChild(submitLabel);

    submitTab.addEventListener('click', () => this.switchToTab(this.questions.length));
    tabsContainer.appendChild(submitTab);

    // Right arrow
    const rightArrow = document.createElement('span');
    rightArrow.className = 'claudian-ask-panel-nav';
    rightArrow.textContent = '→';
    rightArrow.addEventListener('click', () => this.navigateTab(1));
    tabsContainer.appendChild(rightArrow);

    parent.appendChild(tabsContainer);
    return tabsContainer;
  }

  /** Navigate tabs by direction. */
  private navigateTab(direction: number): void {
    const newIndex = this.currentTabIndex + direction;
    // Allow navigation to Submit tab (index = questions.length)
    if (newIndex >= 0 && newIndex <= this.questions.length) {
      this.switchToTab(newIndex);
    }
  }

  /** Check if currently on Submit tab. */
  private isOnSubmitTab(): boolean {
    return this.currentTabIndex === this.questions.length;
  }

  /** Switch to a specific tab/question. */
  private switchToTab(index: number): void {
    // Allow Submit tab (index = questions.length)
    if (index < 0 || index > this.questions.length) return;

    this.currentTabIndex = index;
    this.currentOptionIndex = 0;

    // Update tab active state
    if (this.tabsEl) {
      const tabs = this.tabsEl.querySelectorAll('.claudian-ask-panel-tab');
      tabs.forEach((tab, i) => {
        tab.classList.toggle('active', i === index);
      });
    }

    this.renderCurrentContent();
  }

  /** Render current tab content. */
  private renderCurrentContent(): void {
    if (this.isOnSubmitTab()) {
      this.renderSubmitReview();
    } else {
      this.renderCurrentQuestion();
    }
  }

  /** Render the current question. */
  private renderCurrentQuestion(): void {
    if (!this.questionContentEl) return;
    this.questionContentEl.innerHTML = '';

    const question = this.questions[this.currentTabIndex];
    if (!question) return;

    // Question text
    const questionTextEl = document.createElement('div');
    questionTextEl.className = 'claudian-ask-panel-question';
    questionTextEl.textContent = question.question;
    this.questionContentEl.appendChild(questionTextEl);

    // Options
    const optionsEl = document.createElement('div');
    optionsEl.className = 'claudian-ask-panel-options';
    optionsEl.setAttribute('role', question.multiSelect ? 'group' : 'radiogroup');

    question.options.forEach((option, index) => {
      const optionEl = this.createOptionElement(question, option, index);
      optionsEl.appendChild(optionEl);
    });

    // "Other" option (numbered as last)
    const otherEl = this.createOtherOption(question);
    optionsEl.appendChild(otherEl);

    this.questionContentEl.appendChild(optionsEl);

    // Update visual focus
    this.updateOptionFocus();
  }

  /** Render the Submit review panel. */
  private renderSubmitReview(): void {
    if (!this.questionContentEl) return;
    this.questionContentEl.innerHTML = '';

    // Title
    const titleEl = document.createElement('div');
    titleEl.className = 'claudian-ask-panel-question';
    titleEl.textContent = 'Review your answers';
    this.questionContentEl.appendChild(titleEl);

    // Summary of all answers
    const summaryEl = document.createElement('div');
    summaryEl.className = 'claudian-ask-panel-summary';

    this.questions.forEach((q) => {
      const itemEl = document.createElement('div');
      itemEl.className = 'claudian-ask-panel-summary-item';

      // Question with bullet
      const questionEl = document.createElement('div');
      questionEl.className = 'claudian-ask-panel-summary-question';
      questionEl.textContent = `● ${q.question}`;
      itemEl.appendChild(questionEl);

      // Answer (green)
      const answerEl = document.createElement('div');
      answerEl.className = 'claudian-ask-panel-summary-answer';
      const answer = this.answers.get(q.question);
      if (answer) {
        const answerText = Array.isArray(answer) ? answer.join(', ') : answer;
        answerEl.textContent = `  → ${answerText}`;
      } else {
        answerEl.textContent = '  → (not answered)';
        answerEl.classList.add('unanswered');
      }
      itemEl.appendChild(answerEl);

      summaryEl.appendChild(itemEl);
    });

    this.questionContentEl.appendChild(summaryEl);

    // Confirmation prompt
    const promptEl = document.createElement('div');
    promptEl.className = 'claudian-ask-panel-submit-prompt';
    promptEl.textContent = 'Ready to submit your answers?';
    this.questionContentEl.appendChild(promptEl);

    // Options: Submit answers, Cancel
    const optionsEl = document.createElement('div');
    optionsEl.className = 'claudian-ask-panel-options';

    // Submit option
    const submitOptionEl = this.createSubmitOption('Submit answers', 0, () => this.submit());
    optionsEl.appendChild(submitOptionEl);

    // Cancel option
    const cancelOptionEl = this.createSubmitOption('Cancel', 1, () => this.cancel());
    optionsEl.appendChild(cancelOptionEl);

    this.questionContentEl.appendChild(optionsEl);

    // Update focus
    this.updateSubmitOptionFocus();
  }

  /** Create an option for the submit review. */
  private createSubmitOption(label: string, index: number, onClick: () => void): HTMLElement {
    const optionEl = document.createElement('div');
    optionEl.className = 'claudian-ask-panel-option claudian-ask-panel-submit-option';
    optionEl.setAttribute('data-option-index', String(index));

    // Caret
    const caret = document.createElement('span');
    caret.className = 'claudian-ask-panel-caret';
    caret.textContent = ' ';
    optionEl.appendChild(caret);

    // Number
    const indicator = document.createElement('span');
    indicator.className = 'claudian-ask-panel-indicator';
    indicator.textContent = `${index + 1}.`;
    optionEl.appendChild(indicator);

    // Label
    const labelEl = document.createElement('span');
    labelEl.className = 'claudian-ask-panel-option-label';
    labelEl.textContent = label;
    optionEl.appendChild(labelEl);

    optionEl.addEventListener('click', () => {
      this.currentOptionIndex = index;
      this.updateSubmitOptionFocus();
      onClick();
    });

    return optionEl;
  }

  /** Update focus for submit options. */
  private updateSubmitOptionFocus(): void {
    if (!this.questionContentEl) return;

    const options = this.questionContentEl.querySelectorAll('.claudian-ask-panel-submit-option');
    options.forEach((opt, i) => {
      const caret = opt.querySelector('.claudian-ask-panel-caret');
      const isFocused = i === this.currentOptionIndex;
      opt.classList.toggle('focused', isFocused);
      if (caret) {
        caret.textContent = isFocused ? '>' : ' ';
      }
    });
  }

  /** Create an option element. */
  private createOptionElement(
    question: AskUserQuestionQuestion,
    option: { label: string; description: string },
    index: number
  ): HTMLElement {
    const optionEl = document.createElement('div');
    optionEl.className = 'claudian-ask-panel-option';
    optionEl.setAttribute('data-option-index', String(index));

    // Focus caret indicator (> or space)
    const caret = document.createElement('span');
    caret.className = 'claudian-ask-panel-caret';
    caret.textContent = ' ';
    optionEl.appendChild(caret);

    // Number/checkbox indicator
    const indicator = document.createElement('span');
    indicator.className = 'claudian-ask-panel-indicator';
    if (question.multiSelect) {
      indicator.textContent = `${index + 1}. [ ]`;
    } else {
      indicator.textContent = `${index + 1}.`;
    }
    optionEl.appendChild(indicator);

    // Label and description
    const textContainer = document.createElement('div');
    textContainer.className = 'claudian-ask-panel-option-text';

    // Label row (contains label + checkmark for single-select)
    const labelRowEl = document.createElement('div');
    labelRowEl.className = 'claudian-ask-panel-label-row';

    const labelEl = document.createElement('span');
    labelEl.className = 'claudian-ask-panel-option-label';
    labelEl.textContent = option.label;
    labelRowEl.appendChild(labelEl);

    // Checkmark for single-select (shown after label when selected)
    if (!question.multiSelect) {
      const checkmarkEl = document.createElement('span');
      checkmarkEl.className = 'claudian-ask-panel-checkmark';
      checkmarkEl.textContent = '';
      labelRowEl.appendChild(checkmarkEl);
    }

    textContainer.appendChild(labelRowEl);

    if (option.description) {
      const descEl = document.createElement('div');
      descEl.className = 'claudian-ask-panel-option-desc';
      descEl.textContent = option.description;
      textContainer.appendChild(descEl);
    }

    optionEl.appendChild(textContainer);

    // Click handler
    optionEl.addEventListener('click', () => {
      this.currentOptionIndex = index;
      this.selectOption(index);
    });

    return optionEl;
  }

  /** Create the "Other" option with text input. */
  private createOtherOption(question: AskUserQuestionQuestion): HTMLElement {
    const otherIndex = question.options.length;

    const otherEl = document.createElement('div');
    otherEl.className = 'claudian-ask-panel-option claudian-ask-panel-other';
    otherEl.setAttribute('data-option-index', String(otherIndex));

    // Focus caret indicator
    const caret = document.createElement('span');
    caret.className = 'claudian-ask-panel-caret';
    caret.textContent = ' ';
    otherEl.appendChild(caret);

    // Number/checkbox indicator
    const indicator = document.createElement('span');
    indicator.className = 'claudian-ask-panel-indicator';
    if (question.multiSelect) {
      indicator.textContent = `${otherIndex + 1}. [ ]`;
    } else {
      indicator.textContent = `${otherIndex + 1}.`;
    }
    otherEl.appendChild(indicator);

    // Text input
    this.otherInputEl = document.createElement('input');
    this.otherInputEl.type = 'text';
    this.otherInputEl.className = 'claudian-ask-panel-other-input';
    this.otherInputEl.placeholder = 'Type something.';

    // Enter to submit from Other input
    this.otherInputEl.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        e.stopPropagation();
        return;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        e.stopPropagation();
        if (this.otherInputEl && this.otherInputEl.value.trim()) {
          this.selectOther(this.otherInputEl.value.trim());
        }
      }
    });

    // Focus handler
    this.otherInputEl.addEventListener('focus', () => {
      this.currentOptionIndex = otherIndex;
      this.updateOptionFocus();
    });

    otherEl.appendChild(this.otherInputEl);

    // Click handler for the container
    otherEl.addEventListener('click', (e) => {
      if (e.target !== this.otherInputEl) {
        this.currentOptionIndex = otherIndex;
        this.updateOptionFocus();
        this.otherInputEl?.focus();
      }
    });

    return otherEl;
  }

  /** Handle keyboard navigation. */
  private handleKeyDown(e: KeyboardEvent): void {
    if (this.isDestroyed) return;

    // Handle Submit tab separately
    if (this.isOnSubmitTab()) {
      this.handleSubmitTabKeyDown(e);
      return;
    }

    const question = this.questions[this.currentTabIndex];
    if (!question) return;

    const totalOptions = question.options.length + 1; // +1 for "Other"

    switch (e.key) {
      case 'ArrowUp':
        e.preventDefault();
        this.currentOptionIndex = (this.currentOptionIndex - 1 + totalOptions) % totalOptions;
        this.updateOptionFocus();
        break;

      case 'ArrowDown':
        e.preventDefault();
        this.currentOptionIndex = (this.currentOptionIndex + 1) % totalOptions;
        this.updateOptionFocus();
        break;

      case 'ArrowLeft':
        e.preventDefault();
        this.navigateTab(-1);
        break;

      case 'ArrowRight':
        e.preventDefault();
        this.navigateTab(1);
        break;

      case 'Tab':
        e.preventDefault();
        if (e.shiftKey) {
          this.navigateTab(-1);
        } else {
          this.navigateTab(1);
        }
        break;

      case 'Enter':
        // Don't handle if focus is in Other input (it has its own handler)
        if (document.activeElement === this.otherInputEl) return;

        e.preventDefault();
        if (this.currentOptionIndex < question.options.length) {
          this.selectOption(this.currentOptionIndex);
        } else if (this.otherInputEl && this.otherInputEl.value.trim()) {
          this.selectOther(this.otherInputEl.value.trim());
        }
        break;

      case 'Escape':
        e.preventDefault();
        this.cancel();
        break;

      // Number keys 1-9 for quick selection
      case '1': case '2': case '3': case '4': case '5':
      case '6': case '7': case '8': case '9':
        if (document.activeElement !== this.otherInputEl) {
          const num = parseInt(e.key, 10) - 1;
          if (num < question.options.length) {
            e.preventDefault();
            this.currentOptionIndex = num;
            this.selectOption(num);
          } else if (num === question.options.length) {
            e.preventDefault();
            this.currentOptionIndex = num;
            this.updateOptionFocus();
            this.otherInputEl?.focus();
          }
        }
        break;
    }
  }

  /** Handle keyboard navigation for Submit tab. */
  private handleSubmitTabKeyDown(e: KeyboardEvent): void {
    const totalOptions = 2; // Submit answers, Cancel

    switch (e.key) {
      case 'ArrowUp':
        e.preventDefault();
        this.currentOptionIndex = (this.currentOptionIndex - 1 + totalOptions) % totalOptions;
        this.updateSubmitOptionFocus();
        break;

      case 'ArrowDown':
        e.preventDefault();
        this.currentOptionIndex = (this.currentOptionIndex + 1) % totalOptions;
        this.updateSubmitOptionFocus();
        break;

      case 'ArrowLeft':
        e.preventDefault();
        this.navigateTab(-1);
        break;

      case 'ArrowRight':
        // Can't go right from Submit tab
        break;

      case 'Tab':
        e.preventDefault();
        if (e.shiftKey) {
          this.navigateTab(-1);
        }
        // Can't tab forward from Submit tab
        break;

      case 'Enter':
        e.preventDefault();
        if (this.currentOptionIndex === 0) {
          this.submit();
        } else {
          this.cancel();
        }
        break;

      case 'Escape':
        e.preventDefault();
        this.cancel();
        break;

      case '1':
        e.preventDefault();
        this.currentOptionIndex = 0;
        this.updateSubmitOptionFocus();
        this.submit();
        break;

      case '2':
        e.preventDefault();
        this.currentOptionIndex = 1;
        this.updateSubmitOptionFocus();
        this.cancel();
        break;
    }
  }

  private attachDocumentHandler(): void {
    this.detachDocumentHandler();
    this.documentKeydownHandler = (e: KeyboardEvent) => {
      if (this.isDestroyed) return;
      if (!this.isNavigationKey(e)) return;
      e.preventDefault();
      e.stopPropagation();
      this.handleKeyDown(e);
    };
    document.addEventListener('keydown', this.documentKeydownHandler, true);
  }

  private detachDocumentHandler(): void {
    if (this.documentKeydownHandler) {
      document.removeEventListener('keydown', this.documentKeydownHandler, true);
      this.documentKeydownHandler = null;
    }
  }

  private isNavigationKey(e: KeyboardEvent): boolean {
    return (
      e.key === 'ArrowUp' ||
      e.key === 'ArrowDown' ||
      e.key === 'ArrowLeft' ||
      e.key === 'ArrowRight' ||
      e.key === 'Tab'
    );
  }

  /** Update visual focus indicator. */
  private updateOptionFocus(): void {
    if (!this.questionContentEl) return;

    const question = this.questions[this.currentTabIndex];
    if (!question) return;

    const questionKey = question.question;
    const answer = this.answers.get(questionKey);
    const answerArray = Array.isArray(answer) ? answer : (answer ? [answer] : []);

    const options = this.questionContentEl.querySelectorAll('.claudian-ask-panel-option');
    options.forEach((opt, i) => {
      const caret = opt.querySelector('.claudian-ask-panel-caret');
      const indicator = opt.querySelector('.claudian-ask-panel-indicator');
      const isFocused = i === this.currentOptionIndex;

      // Check if this option is selected
      let isSelected = false;
      if (i < question.options.length) {
        const optionLabel = question.options[i].label;
        isSelected = answerArray.includes(optionLabel);
      } else {
        isSelected = answerArray.some(v => typeof v === 'string' && !question.options.some(o => o.label === v));
      }

      opt.classList.toggle('focused', isFocused);
      opt.classList.toggle('selected', isSelected);

      // Update caret (> or space)
      if (caret) {
        caret.textContent = isFocused ? '>' : ' ';
      }

      // Update indicator (number and checkbox for multiSelect)
      if (indicator) {
        if (question.multiSelect) {
          const checkbox = isSelected ? '[✓]' : '[ ]';
          indicator.textContent = `${i + 1}. ${checkbox}`;
        } else {
          // For single select, just show number
          indicator.textContent = `${i + 1}.`;
        }
      }

      // Update checkmark for single-select (shown after label)
      if (!question.multiSelect) {
        const checkmark = opt.querySelector('.claudian-ask-panel-checkmark');
        if (checkmark) {
          checkmark.textContent = isSelected ? ' ✓' : '';
        }
      }
    });

    // Focus the Other input if it's selected
    if (this.currentOptionIndex === question.options.length) {
      this.otherInputEl?.focus();
    } else {
      // Remove focus from Other input
      if (document.activeElement === this.otherInputEl) {
        this.panelEl.focus();
      }
    }
  }

  /** Select an option. */
  private selectOption(optionIndex: number): void {
    const question = this.questions[this.currentTabIndex];
    if (!question || optionIndex >= question.options.length) return;

    const option = question.options[optionIndex];
    const questionKey = question.question;

    if (question.multiSelect) {
      // Toggle selection for multi-select
      const current = this.answers.get(questionKey);
      const currentArray = Array.isArray(current) ? current : [];

      if (currentArray.includes(option.label)) {
        const filtered = currentArray.filter(v => v !== option.label);
        if (filtered.length > 0) {
          this.answers.set(questionKey, filtered);
        } else {
          this.answers.delete(questionKey);
        }
      } else {
        this.answers.set(questionKey, [...currentArray, option.label]);
      }

      this.updateSelectionUI();
    } else {
      // Single select - set and auto-advance
      this.answers.set(questionKey, option.label);
      this.updateSelectionUI();
      this.autoAdvance();
    }
  }

  /** Select "Other" with custom text. */
  private selectOther(text: string): void {
    const question = this.questions[this.currentTabIndex];
    if (!question) return;

    const questionKey = question.question;

    if (question.multiSelect) {
      const current = this.answers.get(questionKey);
      const currentArray = Array.isArray(current) ? current : [];
      const filtered = currentArray.filter(v => question.options.some(o => o.label === v));
      this.answers.set(questionKey, [...filtered, text]);
      this.updateSelectionUI();
    } else {
      this.answers.set(questionKey, text);
      this.updateSelectionUI();
      this.autoAdvance();
    }
  }

  /** Update selection UI indicators. */
  private updateSelectionUI(): void {
    this.updateOptionFocus();
    this.updateTabIndicators();
  }

  /** Update tab checkbox indicators. */
  private updateTabIndicators(): void {
    if (!this.tabsEl) return;

    const tabs = this.tabsEl.querySelectorAll('.claudian-ask-panel-tab');
    this.questions.forEach((q, i) => {
      const hasAnswer = this.answers.has(q.question);
      const tab = tabs[i];
      if (tab) {
        tab.classList.toggle('answered', hasAnswer);
        const check = tab.querySelector('.claudian-ask-panel-tab-check');
        if (check) {
          check.textContent = hasAnswer ? '●' : '○';
        }
      }
    });
  }

  /** Auto-advance to next question or Submit tab. */
  private autoAdvance(): void {
    // Always advance to next tab (including Submit tab at the end)
    this.switchToTab(this.currentTabIndex + 1);
  }

  /** Submit all answers. */
  private submit(): void {
    if (this.isDestroyed) return;

    const answersRecord: Record<string, string | string[]> = {};
    this.answers.forEach((value, key) => {
      answersRecord[key] = value;
    });

    this.destroy();
    this.onSubmit(answersRecord);
  }

  /** Cancel and close panel. */
  private cancel(): void {
    if (this.isDestroyed) return;
    this.destroy();
    this.onCancel();
  }

  /** Clean up and remove panel, restore input area. */
  destroy(): void {
    if (this.isDestroyed) return;
    this.isDestroyed = true;

    this.detachDocumentHandler();
    this.panelEl.remove();

    if (this.inputWrapper) {
      this.inputWrapper.style.display = '';
    }
  }
}

/**
 * Show the AskUserQuestion panel and wait for response.
 */
export function showAskUserQuestionPanel(
  app: App,
  containerEl: HTMLElement,
  input: AskUserQuestionInput
): Promise<Record<string, string | string[]> | null> {
  return new Promise((resolve) => {
    new AskUserQuestionPanel(app, {
      containerEl,
      input,
      onSubmit: (answers) => resolve(answers),
      onCancel: () => resolve(null),
    });
  });
}
