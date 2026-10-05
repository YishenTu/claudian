import { extractResolvedAnswersFromResultText } from '@/core/tools/toolInput';
import type {
  AskUserQuestionItem,
  AskUserQuestionOption,
  ToolCallInfo,
} from '@/core/types';
import { contentFallback } from '@/features/chat/rendering/tools/toolContentPrimitives';

function formatAnswer(raw: unknown): string {
  if (Array.isArray(raw)) return raw.join(', ');
  if (typeof raw === 'string') return raw;
  return '';
}

function resolveAskUserAnswers(toolCall: ToolCallInfo): Record<string, unknown> | undefined {
  if (toolCall.resolvedAnswers) return toolCall.resolvedAnswers;

  const parsed = extractResolvedAnswersFromResultText(toolCall.result);
  if (parsed) {
    toolCall.resolvedAnswers = parsed;
    return parsed;
  }

  return undefined;
}

function renderAskUserQuestionResult(container: HTMLElement, toolCall: ToolCallInfo): boolean {
  const questions = toolCall.input.questions as AskUserQuestionItem[] | undefined;
  const answers = resolveAskUserAnswers(toolCall);
  if (!questions || !Array.isArray(questions) || !answers) return false;
  if (!questions.some(question => (question.id && question.id in answers) || question.question in answers)) return false;
  if (toolCall.input.replyMode === 'user-message' && !questions.every(question => (question.id && question.id in answers) || question.question in answers)) return false;
  container.empty();

  const reviewEl = container.createDiv({ cls: 'claudian-ask-review' });
  for (let i = 0; i < questions.length; i++) {
    const q = questions[i];
    const answer = formatAnswer(
      (q.id ? answers[q.id] : undefined) ?? answers[q.question]
    );
    const pairEl = reviewEl.createDiv({ cls: 'claudian-ask-review-pair' });
    const bodyEl = pairEl.createDiv({ cls: 'claudian-ask-review-body' });
    bodyEl.createDiv({ text: q.question, cls: 'claudian-ask-review-q-text' });
    bodyEl.createDiv({
      text: answer || 'Not answered',
      cls: answer ? 'claudian-ask-review-a-text' : 'claudian-ask-review-empty',
    });
  }

  return true;
}

function renderAskUserQuestionOption(
  parentEl: HTMLElement,
  option: AskUserQuestionOption,
  isMultiSelect: boolean,
): void {
  const itemEl = parentEl.createDiv({ cls: 'claudian-ask-item is-disabled' });

  if (isMultiSelect) {
    itemEl.createDiv({ cls: 'claudian-ask-check', attr: { 'aria-hidden': 'true' } });
  } else {
    itemEl.createDiv({ cls: 'claudian-ask-radio', attr: { 'aria-hidden': 'true' } });
  }

  const contentEl = itemEl.createDiv({ cls: 'claudian-ask-item-content' });
  const labelRowEl = contentEl.createDiv({ cls: 'claudian-ask-label-row' });
  labelRowEl.createDiv({ cls: 'claudian-ask-item-label', text: option.label });

  if (option.description) {
    contentEl.createDiv({ cls: 'claudian-ask-item-desc', text: option.description });
  }
}

function renderAskUserQuestionFallback(container: HTMLElement, toolCall: ToolCallInfo, initialText?: string): void {
  container.empty();

  const questions = Array.isArray(toolCall.input.questions)
    ? toolCall.input.questions as AskUserQuestionItem[]
    : [];

  if (questions.length === 0) {
    contentFallback(container, initialText || toolCall.result || 'Waiting for answer...');
    return;
  }

  if (initialText || toolCall.result) {
    container.createDiv({
      cls: 'claudian-ask-review-prompt',
      text: initialText || toolCall.result || 'Waiting for answer...',
    });
  }

  for (let questionIndex = 0; questionIndex < questions.length; questionIndex++) {
    const question = questions[questionIndex];
    const reviewEl = container.createDiv({ cls: 'claudian-ask-review' });
    const pairEl = reviewEl.createDiv({ cls: 'claudian-ask-review-pair' });
    const bodyEl = pairEl.createDiv({ cls: 'claudian-ask-review-body' });
    bodyEl.createDiv({ text: question.question, cls: 'claudian-ask-review-q-text' });

    if (!Array.isArray(question.options) || question.options.length === 0) {
      bodyEl.createDiv({ cls: 'claudian-ask-review-empty', text: 'No options recorded' });
      continue;
    }

    const listEl = bodyEl.createDiv({ cls: 'claudian-ask-list' });
    question.options.forEach((option) => {
      renderAskUserQuestionOption(listEl, option, question.multiSelect === true);
    });
  }
}

/**
 * Card body for a question: the answered review once answers resolve, otherwise
 * the recorded options with a prompt (`pending` while the live card awaits them).
 */
export function renderAskUserQuestionContent(container: HTMLElement, tool: ToolCallInfo, pending: boolean): void {
  container.addClass('claudian-tool-content-ask');
  if (renderAskUserQuestionResult(container, tool)) return;
  const prompt = tool.input.replyMode === 'user-message'
    ? tool.questionStatus === 'pending' ? 'Answer in the question panel below.' : 'Question expired.'
    : pending ? 'Waiting for answer...' : undefined;
  renderAskUserQuestionFallback(container, tool, prompt);
}
