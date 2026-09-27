import type { AskUserAnswers, AskUserQuestionItem } from '../../../core/types';

export type QuestionAnswerHandler = (answers: AskUserAnswers) => Promise<void>;

/** Non-blocking questions stay in the transcript and submit through their owning destination. */
export function renderAsyncQuestionForm(
  container: HTMLElement,
  questions: AskUserQuestionItem[],
  onAnswer: QuestionAnswerHandler,
): void {
  const form = container.createEl('form', { cls: 'claudian-ask-async' });
  const readers: Array<() => string> = [];
  for (const [index, question] of questions.entries()) {
    const group = form.createEl('fieldset');
    group.createEl('legend', { text: question.question });
    const radios: HTMLInputElement[] = [];
    for (const option of question.options ?? []) {
      const label = group.createEl('label', { cls: 'claudian-ask-async-option' });
      const radio = label.createEl('input', { attr: { type: 'radio', name: `question-${index}`, value: option.label } });
      radios.push(radio);
      label.createSpan({ text: option.label });
    }
    const customLabel = group.createEl('label', { cls: 'claudian-ask-async-custom' });
    customLabel.createSpan({ text: 'Your answer' });
    const custom = customLabel.createEl('input', { attr: { type: 'text', 'aria-label': `Your answer to ${question.question}` } });
    custom.addEventListener('input', () => { if (custom.value) for (const radio of radios) radio.checked = false; });
    for (const radio of radios) radio.addEventListener('change', () => { custom.value = ''; });
    readers.push(() => custom.value.trim() || radios.find(radio => radio.checked)?.value || '');
  }
  const error = form.createDiv({ attr: { role: 'alert' } });
  const submit = form.createEl('button', { text: 'Send answer', attr: { type: 'submit' } });
  submit.disabled = true;
  let sending = false;
  const refresh = () => { submit.disabled = sending || readers.some(read => !read()); };
  form.addEventListener('input', refresh);
  form.addEventListener('change', refresh);
  form.addEventListener('submit', event => {
    event.preventDefault();
    if (sending || readers.some(read => !read())) return;
    const answers = Object.fromEntries(questions.map((question, index) => [question.id ?? question.question, readers[index]()])) as AskUserAnswers;
    sending = true;
    submit.textContent = 'Sending...';
    error.textContent = '';
    for (const fieldset of form.querySelectorAll('fieldset')) fieldset.disabled = true;
    refresh();
    void onAnswer(answers).catch(reason => {
      error.textContent = reason instanceof Error ? reason.message : 'Could not send the answer. Please try again.';
    }).finally(() => {
      sending = false;
      submit.textContent = 'Send answer';
      for (const fieldset of form.querySelectorAll('fieldset')) fieldset.disabled = false;
      refresh();
    });
  });
}
