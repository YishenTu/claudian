/** @jest-environment jsdom */
import { fireEvent, within } from '@testing-library/dom';

import { SessionInteractions } from '@/features/chat/interactions/SessionInteractions';

HTMLElement.prototype.empty = function () { this.replaceChildren(); };
HTMLElement.prototype.addClass = function (...classes) { this.classList.add(...classes); };
HTMLElement.prototype.removeClass = function (...classes) { this.classList.remove(...classes); };
HTMLElement.prototype.toggleClass = function (name, force) { for (const item of Array.isArray(name) ? name : [name]) this.classList.toggle(item, force); };
HTMLElement.prototype.scrollIntoView = function () {};

afterEach(() => { document.body.replaceChildren(); });

it('keeps an approval requested without a view pending until the user answers after attachment', async () => {
  let parent: HTMLElement | null = null;
  const prompts = new SessionInteractions({ getPromptParentEl: () => parent });
  let settled = false;
  const pending = prompts.requestApproval('approval', 'Bash', {}, 'Run the check').finally(() => { settled = true; });
  void pending.catch(() => undefined);
  await Promise.resolve();
  await Promise.resolve();
  expect(settled).toBe(false);
  parent = document.body.createDiv();
  prompts.setActive(true);
  fireEvent.click(within(parent).getByRole('button', { name: 'Allow once' }));
  await expect(pending).resolves.toBe('allow');
});

it('keeps answer drafts and an in-flight submission across presentation disposal', async () => {
  let parent = document.body.createDiv();
  const prompts = new SessionInteractions({ getPromptParentEl: () => parent });
  let fail!: (error: Error) => void;
  const delivery = new Promise<void>((_resolve, reject) => { fail = reject; });
  const answer = jest.fn().mockReturnValueOnce(delivery).mockResolvedValue(undefined);
  let settled = false;
  const pending = prompts.askUserQuestion('question', { questions: [
    { id: 'scope', question: 'Which scope?', isOther: true, options: [{ label: 'All' }] },
  ] }, undefined, { onSubmit: answer }).finally(() => { settled = true; });
  const draft = within(parent).getByRole('textbox', { name: 'Which scope?' });
  fireEvent.input(draft, { target: { value: 'Only this file' } });
  prompts.detachPresentation();
  parent.remove();
  parent = document.body.createDiv();
  prompts.setActive(true);
  expect((within(parent).getByRole('textbox', { name: 'Which scope?' }) as HTMLInputElement).value).toBe('Only this file');
  fireEvent.click(within(parent).getByRole('button', { name: 'Submit' }));
  fireEvent.click(within(parent).getByRole('button', { name: 'Submit answers' }));
  expect(answer).toHaveBeenCalledTimes(1);
  prompts.detachPresentation();
  parent.remove();
  parent = document.body.createDiv();
  prompts.setActive(true);
  expect((within(parent).getByRole('button', { name: 'Sending...' }) as HTMLButtonElement).disabled).toBe(true);
  expect(settled).toBe(false);
  fail(new Error('Definitely not sent'));
  await Promise.resolve();
  await Promise.resolve();
  expect(within(parent).getByRole('alert').textContent).toBe('Definitely not sent');
  fireEvent.click(within(parent).getByRole('button', { name: 'Submit answers' }));
  await expect(pending).resolves.toEqual({ scope: 'Only this file' });
  expect(answer).toHaveBeenCalledTimes(2);
});
