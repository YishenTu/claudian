/** @jest-environment jsdom */

import { fireEvent, within } from '@testing-library/dom';

import { InlineAskUserQuestion } from '@/features/chat/rendering/InlineAskUserQuestion';

HTMLElement.prototype.empty = function () { this.replaceChildren(); };
HTMLElement.prototype.addClass = function (...classes) { this.classList.add(...classes); };
HTMLElement.prototype.removeClass = function (...classes) { this.classList.remove(...classes); };
HTMLElement.prototype.toggleClass = function (names, enabled) {
  for (const name of Array.isArray(names) ? names : [names]) this.classList.toggle(name, enabled);
};
HTMLElement.prototype.scrollIntoView = function () {};
HTMLElement.prototype.setText = function (text) { this.textContent = String(text); };

beforeEach(() => document.body.replaceChildren());

it.each([
  ['ArrowDown', 'Always allow'],
  ['ArrowUp', 'Allow once'],
])('keeps permission selection aligned with native focus before %s', (key, expected) => {
  const resolve = jest.fn();
  const panel = new InlineAskUserQuestion(document.body.createDiv(), {
    questions: [{
      question: 'Allow this command?', header: 'Permission',
      options: ['Deny', 'Allow once', 'Always allow'].map(label => ({ label })),
    }],
  }, resolve, undefined, { immediateSelect: true, showCustomInput: false });
  panel.render();
  const choice = within(document.body).getByRole('button', { name: 'Always allow' });
  // Native Tab navigation focuses choices without clicking them.
  choice.focus();
  fireEvent.keyDown(choice, { key });
  const root = within(document.body).getByRole('region', { name: 'Question' });
  expect(document.activeElement).toBe(root);
  fireEvent.keyDown(root, { key: 'Enter' });
  expect(resolve).toHaveBeenCalledWith({ 'Allow this command?': expected });
});

it('checks the multi-select custom answer as soon as text is typed', () => {
  const panel = new InlineAskUserQuestion(document.body.createDiv(), {
    questions: [{ question: 'Which checks?', isOther: true, multiSelect: true, options: [{ label: 'Lint' }] }],
  }, jest.fn());
  panel.render();
  const input = within(document.body).getByRole('textbox', { name: 'Which checks?' });
  const customRow = input.closest('.claudian-ask-custom-item')!;

  fireEvent.input(input, { target: { value: 'Typecheck' } });
  expect(customRow.querySelector('.claudian-ask-check')?.classList.contains('is-checked')).toBe(true);

  fireEvent.input(input, { target: { value: '' } });
  expect(customRow.querySelector('.claudian-ask-check')?.classList.contains('is-checked')).toBe(false);
});
