/**
 * AskUserQuestion renderer.
 *
 * Renders the AskUserQuestion tool call block showing questions and answers.
 * Note: During streaming, no block is shown - only the floating panel.
 * The block only appears AFTER the user responds to show the Q&A summary.
 */

import { setIcon } from 'obsidian';

import type { AskUserQuestionInput, AskUserQuestionQuestion, ToolCallInfo } from '../../core/types';

/** State for an AskUserQuestion block (created after user responds). */
export interface AskUserQuestionState {
  wrapperEl: HTMLElement;
  contentEl: HTMLElement;
  headerEl: HTMLElement;
  toolId: string;
}

/** Parse AskUserQuestion input and extract questions/answers. */
export function parseAskUserQuestionInput(
  input: Record<string, unknown>
): AskUserQuestionInput | null {
  if (!input || typeof input !== 'object') return null;

  const questions = input.questions as AskUserQuestionQuestion[] | undefined;
  if (!Array.isArray(questions)) return null;

  return {
    questions,
    answers: input.answers as Record<string, string | string[]> | undefined,
  };
}

/** Format a single answer for display. */
function formatAnswer(answer: string | string[]): string {
  if (Array.isArray(answer)) {
    return answer.join(', ');
  }
  return answer;
}

/** Render Q&A content in markdown-like list format. */
function renderTreeQA(
  containerEl: HTMLElement,
  questions: AskUserQuestionQuestion[],
  answers: Record<string, string | string[]>
): void {
  const listEl = containerEl.createDiv({ cls: 'claudian-ask-question-list' });

  // Tree symbol outside the aligned container (avoids Unicode width issues)
  const treeEl = listEl.createSpan({ cls: 'claudian-ask-question-tree' });
  treeEl.setText('⎿ ');

  // Container for all Q&A - everything inside aligns naturally
  const alignedEl = listEl.createDiv({ cls: 'claudian-ask-question-aligned' });

  questions.forEach((question) => {
    const answer = answers[question.question];
    if (answer === undefined) return;

    const itemEl = alignedEl.createDiv({ cls: 'claudian-ask-question-item' });

    // Question
    const qEl = itemEl.createDiv({ cls: 'claudian-ask-question-q' });
    qEl.setText(`Q: ${question.question}`);

    // Answer aligned with Q
    const aEl = itemEl.createDiv({ cls: 'claudian-ask-question-a' });
    aEl.setText(`A: ${formatAnswer(answer)}`);
  });
}

/**
 * Create a placeholder for AskUserQuestion during streaming.
 * This is invisible - the actual UI is the floating panel.
 * The placeholder will be replaced with the Q&A block after response.
 */
export function createAskUserQuestionBlock(
  parentEl: HTMLElement,
  toolCall: ToolCallInfo
): AskUserQuestionState {
  // Create an invisible placeholder that will be populated after response
  const wrapperEl = parentEl.createDiv({ cls: 'claudian-ask-question-block claudian-ask-question-pending' });
  wrapperEl.dataset.toolId = toolCall.id;
  wrapperEl.style.display = 'none'; // Hidden until response received

  const headerEl = wrapperEl.createDiv({ cls: 'claudian-ask-question-header' });
  const contentEl = wrapperEl.createDiv({ cls: 'claudian-ask-question-content' });

  return {
    wrapperEl,
    contentEl,
    headerEl,
    toolId: toolCall.id,
  };
}

/**
 * Finalize an AskUserQuestion block with answers.
 * This makes the block visible and populates it with Q&A.
 */
export function finalizeAskUserQuestionBlock(
  state: AskUserQuestionState,
  answers: Record<string, string | string[]> | undefined,
  isError: boolean,
  questions?: AskUserQuestionQuestion[]
): void {
  const questionList = questions || [];
  const questionCount = questionList.length;

  // Make visible
  state.wrapperEl.style.display = '';
  state.wrapperEl.removeClass('claudian-ask-question-pending');

  // Determine status class
  if (isError) {
    state.wrapperEl.addClass('error');
  } else {
    state.wrapperEl.addClass('done');
  }

  // Build header
  state.headerEl.empty();
  state.headerEl.setAttribute('tabindex', '0');
  state.headerEl.setAttribute('role', 'button');
  state.headerEl.setAttribute('aria-expanded', 'false');

  // Question icon
  const iconEl = state.headerEl.createDiv({ cls: 'claudian-ask-question-icon' });
  iconEl.setAttribute('aria-hidden', 'true');
  setIcon(iconEl, 'help-circle');

  // Label - just "Clarification"
  const labelEl = state.headerEl.createDiv({ cls: 'claudian-ask-question-label' });
  labelEl.setText('Clarification');

  // Question count badge
  const countEl = state.headerEl.createDiv({ cls: 'claudian-ask-question-count' });
  countEl.setText(questionCount === 1 ? '1 question' : `${questionCount} questions`);

  // Status indicator
  const statusEl = state.headerEl.createDiv({ cls: `claudian-ask-question-status status-${isError ? 'error' : 'completed'}` });
  if (isError) {
    setIcon(statusEl, 'x');
  } else {
    setIcon(statusEl, 'check');
  }

  // Build content (collapsed by default)
  state.contentEl.empty();
  state.contentEl.style.display = 'none';

  if (isError || !answers) {
    const errorEl = state.contentEl.createDiv({ cls: 'claudian-ask-question-error' });
    errorEl.setText(isError ? 'Failed to get response' : 'No response received');
  } else {
    // Render tree-style Q&A
    renderTreeQA(state.contentEl, questionList, answers);
  }

  // Toggle collapse handler
  const toggleExpand = () => {
    const expanded = state.wrapperEl.hasClass('expanded');
    if (expanded) {
      state.wrapperEl.removeClass('expanded');
      state.contentEl.style.display = 'none';
      state.headerEl.setAttribute('aria-expanded', 'false');
    } else {
      state.wrapperEl.addClass('expanded');
      state.contentEl.style.display = 'block';
      state.headerEl.setAttribute('aria-expanded', 'true');
    }
  };

  // Click handler
  state.headerEl.addEventListener('click', toggleExpand);

  // Keyboard handler (Enter/Space)
  state.headerEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      toggleExpand();
    }
  });
}

/** Render a stored AskUserQuestion tool call from conversation history. */
export function renderStoredAskUserQuestion(
  parentEl: HTMLElement,
  toolCall: ToolCallInfo
): HTMLElement {
  const parsed = parseAskUserQuestionInput(toolCall.input);
  const questions = parsed?.questions || [];
  const answers = parsed?.answers;
  const questionCount = questions.length;
  const isError = toolCall.status === 'error' || toolCall.status === 'blocked';
  const isCompleted = toolCall.status === 'completed';

  const wrapperEl = parentEl.createDiv({ cls: 'claudian-ask-question-block' });
  wrapperEl.dataset.toolId = toolCall.id;

  if (isCompleted) {
    wrapperEl.addClass('done');
  } else if (isError) {
    wrapperEl.addClass('error');
  }

  // Header
  const headerEl = wrapperEl.createDiv({ cls: 'claudian-ask-question-header' });
  headerEl.setAttribute('tabindex', '0');
  headerEl.setAttribute('role', 'button');
  headerEl.setAttribute('aria-expanded', 'false');
  headerEl.setAttribute('aria-label', `Clarification - ${toolCall.status}`);

  // Question icon
  const iconEl = headerEl.createDiv({ cls: 'claudian-ask-question-icon' });
  iconEl.setAttribute('aria-hidden', 'true');
  setIcon(iconEl, 'help-circle');

  // Label - just "Clarification"
  const labelEl = headerEl.createDiv({ cls: 'claudian-ask-question-label' });
  labelEl.setText('Clarification');

  // Question count badge
  const countEl = headerEl.createDiv({ cls: 'claudian-ask-question-count' });
  countEl.setText(questionCount === 1 ? '1 question' : `${questionCount} questions`);

  // Status indicator
  const statusEl = headerEl.createDiv({ cls: `claudian-ask-question-status status-${toolCall.status}` });
  statusEl.setAttribute('aria-label', `Status: ${toolCall.status}`);
  if (isCompleted) {
    setIcon(statusEl, 'check');
  } else if (isError) {
    setIcon(statusEl, 'x');
  }

  // Content (collapsed by default)
  const contentEl = wrapperEl.createDiv({ cls: 'claudian-ask-question-content' });
  contentEl.style.display = 'none';

  // Render tree-style Q&A if answers available
  if (answers && Object.keys(answers).length > 0) {
    renderTreeQA(contentEl, questions, answers);
  } else if (isError) {
    const errorEl = contentEl.createDiv({ cls: 'claudian-ask-question-error' });
    errorEl.setText('Failed to get response');
  } else {
    const noAnswerEl = contentEl.createDiv({ cls: 'claudian-ask-question-error' });
    noAnswerEl.setText('No response recorded');
  }

  // Toggle collapse handler
  const toggleExpand = () => {
    const expanded = wrapperEl.hasClass('expanded');
    if (expanded) {
      wrapperEl.removeClass('expanded');
      contentEl.style.display = 'none';
      headerEl.setAttribute('aria-expanded', 'false');
    } else {
      wrapperEl.addClass('expanded');
      contentEl.style.display = 'block';
      headerEl.setAttribute('aria-expanded', 'true');
    }
  };

  // Click handler
  headerEl.addEventListener('click', toggleExpand);

  // Keyboard handler (Enter/Space)
  headerEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      toggleExpand();
    }
  });

  return wrapperEl;
}
