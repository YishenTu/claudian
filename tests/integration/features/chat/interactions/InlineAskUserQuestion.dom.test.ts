/** @jest-environment jsdom */

import { fireEvent, within } from '@testing-library/dom';
import { axe } from 'jest-axe';

import { InlineAskUserQuestion } from '@/features/chat/interactions/InlineAskUserQuestion';
import { SessionInteractions } from '@/features/chat/interactions/SessionInteractions';
import { setLocale } from '@/i18n/i18n';

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


it('localizes question chrome while submitting provider-authored options unchanged', async () => {
  setLocale('zh-CN');
  const resolve = jest.fn();
  const parent = document.body.createDiv();
  const panel = new InlineAskUserQuestion(parent, {
    questions: [{ question: 'Which checks?', isOther: true, options: [{ label: 'Lint' }] }],
  }, resolve);
  try {
    panel.render();
    const region = within(parent).getByRole('region', { name: '问题' });
    expect(within(region).getByPlaceholderText('输入你的回答…')).toBeDefined();
    fireEvent.click(within(region).getByRole('button', { name: 'Lint' }));
    fireEvent.click(within(region).getByRole('button', { name: '提交' }));
    expect(within(region).getByText('准备提交回答了吗？')).toBeDefined();
    expect(within(region).getByRole('button', { name: '取消' })).toBeDefined();
    expect(await axe(region)).toHaveNoViolations();
    fireEvent.click(within(region).getByRole('button', { name: '提交回答' }));
    expect(resolve).toHaveBeenCalledWith({ 'Which checks?': 'Lint' });
  } finally {
    panel.destroy();
    parent.remove();
    setLocale('en');
  }
});


it('localizes plugin-owned approval prompts and returns stable decisions', async () => {
  setLocale('zh-CN');
  const parent = document.body.createDiv();
  const interactions = new SessionInteractions({ getPromptParentEl: () => parent });
  try {
    const decision = interactions.requestApproval('approval', 'Bash', {}, 'Execute: npm test', { agentID: 'agent-1' });
    const region = within(parent).getByRole('region', { name: '需要授权' });
    expect(within(region).getByText('允许此操作吗？')).toBeDefined();
    expect(within(region).getByRole('region', { name: 'Bash 授权详情' }).textContent).toBe('Execute: npm test');
    expect(within(region).getByText('代理：agent-1')).toBeDefined();
    expect(within(region).getByRole('button', { name: '拒绝' })).toBeDefined();
    expect(within(region).getByRole('button', { name: '始终允许' })).toBeDefined();
    expect(await axe(region)).toHaveNoViolations();
    fireEvent.click(within(region).getByRole('button', { name: '允许一次' }));
    await expect(decision).resolves.toBe('allow');
  } finally {
    interactions.dismiss('approval');
    parent.remove();
    setLocale('en');
  }
});
