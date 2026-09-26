/** @jest-environment jsdom */
import { fireEvent, within } from '@testing-library/dom';
import { axe } from 'jest-axe';

import { InlineAskUserQuestion } from '@/features/chat/rendering/InlineAskUserQuestion';
import { projectOpencodeFormQuestions } from '@/providers/opencode/http/OpencodeHTTPForms';

beforeAll(() => {
  Object.assign(HTMLElement.prototype, {
    empty(this: HTMLElement) { this.replaceChildren(); },
    addClass(this: HTMLElement, ...names: string[]) { this.classList.add(...names); },
    removeClass(this: HTMLElement, ...names: string[]) { this.classList.remove(...names); },
    toggleClass(this: HTMLElement, name: string, force: boolean) { this.classList.toggle(name, force); },
    scrollIntoView() {},
  });
});

// Fields captured from the native v2.0.12 question tool, not UI-shaped fixtures.
const form = (fields: unknown[]) => ({ title: 'Questions', metadata: { kind: 'question' }, fields });
function render(fields: unknown[]) {
  const container = document.body.createDiv();
  const answered = jest.fn();
  const widget = new InlineAskUserQuestion(container, { questions: projectOpencodeFormQuestions(form(fields)) }, answered);
  widget.render();
  return { container, answered, dispose() { widget.destroy(); container.remove(); } };
}

it('shows complete question wording with distinct native headers', () => {
  const f = render([
    { key: 'q0', type: 'string', title: 'Color', description: 'Which color should the report use?', custom: true, options: [{ value: 'Blue', label: 'Blue' }] },
    { key: 'q1', type: 'string', title: 'Sections', description: 'Which sections should the report include?', custom: true, options: [{ value: 'Summary', label: 'Summary' }] },
  ]);
  try {
    expect(within(f.container).getByText('Which color should the report use?')).toBeTruthy();
    fireEvent.click(within(f.container).getByText('Sections'));
    expect(within(f.container).getByText('Which sections should the report include?')).toBeTruthy();
    expect(within(f.container).getByText('Color')).toBeTruthy();
  } finally { f.dispose(); }
});

it('keeps an optionless native question open and submits typed text', async () => {
  const f = render([{ key: 'q0', type: 'string', title: 'Name', description: 'What name should the report use?', custom: true, options: [] }]);
  try {
    expect(f.answered).not.toHaveBeenCalled();
    const input = within(f.container).getByRole('textbox', { name: 'What name should the report use?' });
    expect(await axe(f.container, { runOnly: ['label', 'aria-valid-attr-value', 'aria-roles'] })).toHaveNoViolations();
    fireEvent.input(input, { target: { value: 'Disposable report' } });
    fireEvent.click(within(f.container).getByText('Submit'));
    fireEvent.click(within(f.container).getByText('Submit answers'));
    expect(f.answered).toHaveBeenCalledWith({ q0: 'Disposable report' });
  } finally { f.dispose(); }
});

it('keeps distinct native option values selectable when their labels match', () => {
  const f = render([{ key: 'q0', type: 'string', title: 'Profile', description: 'Choose a profile', options: [{ value: 'a', label: 'Default' }, { value: 'b', label: 'Default' }] }]);
  try {
    const choices = within(f.container).getAllByText('Default');
    expect(choices).toHaveLength(2);
    fireEvent.click(choices[1]);
    fireEvent.click(within(f.container).getByText('Submit'));
    fireEvent.click(within(f.container).getByText('Submit answers'));
    expect(f.answered).toHaveBeenCalledWith({ q0: 'b' });
  } finally { f.dispose(); }
});
