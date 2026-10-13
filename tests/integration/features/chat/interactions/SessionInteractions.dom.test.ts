/** @jest-environment jsdom */
import '@/providers';

import { fireEvent, waitFor, within } from '@testing-library/dom';
import { axe } from 'jest-axe';
import { Notice } from 'obsidian';

import type { ToolCallInfo } from '@/core/types';
import { deliverAsyncQuestion } from '@/features/chat/interactions/asyncQuestionDelivery';
import { createInteractionPromptPort } from '@/features/chat/interactions/interactionPromptPort';
import { SessionInteractions } from '@/features/chat/interactions/SessionInteractions';
import { setLocale } from '@/i18n/i18n';
import { ClaudeExecutionInteractionRouter } from '@/providers/claude/execution/ClaudeExecutionInteractionRouter';

HTMLElement.prototype.empty = function () { this.replaceChildren(); };
HTMLElement.prototype.addClass = function (...classes) { this.classList.add(...classes); };
HTMLElement.prototype.removeClass = function (...classes) { this.classList.remove(...classes); };
HTMLElement.prototype.toggleClass = function (name, force) { for (const item of Array.isArray(name) ? name : [name]) this.classList.toggle(item, force); };
HTMLElement.prototype.scrollIntoView = function () {};

afterEach(() => { document.body.replaceChildren(); setLocale('en'); });

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


it.each([false, true])('localizes explicit Claude approval choices through the real prompt port (persistent: %s)', async persistent => {
  const parent = document.body.createDiv();
  const prompts = new SessionInteractions({ getPromptParentEl: () => parent });
  const router = new ClaudeExecutionInteractionRouter({
    interactionPort: createInteractionPromptPort(() => prompts),
    sessionInstanceId: 'localized', getTurnId: () => 'turn', isToolAllowed: () => true, onToolBlocked: jest.fn(),
  });
  // Construct the adapter before selecting the locale to catch eagerly translated option arrays.
  setLocale('zh-CN');
  const suggestions = [{ type: 'addDirectories' as const, directories: ['/outside'], destination: 'session' as const }];
  const input = { command: 'git status' };
  const result = router.canUseTool('Bash', input, {
    toolUseID: 'approval', requestId: 'request', signal: new AbortController().signal,
    ...(persistent ? { suggestions } : {}),
  });
  try {
    const region = within(parent).getByRole('region', { name: '需要授权' });
    expect(within(region).getByRole('region', { name: 'Bash 授权详情' }).textContent).toBe('运行命令：git status');
    expect(within(region).getByRole('button', { name: '拒绝' })).toBeDefined();
    expect(within(region).queryByRole('button', { name: '始终允许' }) !== null).toBe(persistent);
    expect(await axe(region)).toHaveNoViolations();
    fireEvent.click(within(region).getByRole('button', { name: persistent ? '始终允许' : '允许一次' }));
    await expect(result).resolves.toEqual({
      behavior: 'allow', updatedInput: input,
      ...(persistent ? { updatedPermissions: suggestions, decisionClassification: 'user_permanent' } : { decisionClassification: 'user_temporary' }),
    });
  } finally {
    router.dismissAll('cancelled');
    await result;
  }
});

it.each([
  ['rejected', '回答未发送，请重试。'],
  ['unsupported', '此问题无法接受该回答。'],
] as const)('shows a localized %s delivery failure in the real question panel', async (failure, expected) => {
  setLocale('zh-CN');
  const parent = document.body.createDiv();
  const prompts = new SessionInteractions({ getPromptParentEl: () => parent });
  const tool: ToolCallInfo = { id: 'question', name: 'AskUserQuestion', status: 'completed', questionStatus: 'pending', input: {
    replyMode: 'user-message', questions: [{ id: '0', question: 'Which check?', options: [{ label: 'History' }] }],
  } };
  const steer = jest.fn(async (onDelivery: (accepted: boolean) => void) => { onDelivery(false); return 'accepted' as const; });
  const submit = jest.fn();
  const pending = prompts.askUserQuestion('question', tool.input, undefined, {
    onSubmit: answers => deliverAsyncQuestion(tool, answers, {
      providerId: failure === 'unsupported' ? 'claude' : 'codex', assertCurrent: () => undefined,
      prepare: () => ({ steer, submit }),
    }),
  });
  try {
    const region = within(parent).getByRole('region', { name: '问题' });
    fireEvent.click(within(region).getByRole('button', { name: 'History' }));
    fireEvent.click(within(region).getByRole('button', { name: '提交回答' }));
    await waitFor(() => expect(within(region).getByRole('alert').textContent).toBe(expected));
    expect(within(region).getByText('History')).toBeDefined();
    expect(submit).not.toHaveBeenCalled();
    expect(await axe(region)).toHaveNoViolations();
  } finally {
    prompts.dismiss('question');
    await pending;
  }
});

it('localizes uncertain answer-delivery feedback without requeueing the native reply', async () => {
  setLocale('zh-CN');
  const tool: ToolCallInfo = { id: 'question', name: 'AskUserQuestion', status: 'completed', questionStatus: 'pending', input: {
    replyMode: 'user-message', questions: [{ id: '0', question: 'Which check?', options: [{ label: 'History' }] }],
  } };
  const submit = jest.fn();
  const prepare = jest.fn((_reply: { content: string }) => ({ steer: async () => 'uncertain' as const, submit }));
  await deliverAsyncQuestion(tool, { '0': 'History' }, { providerId: 'codex', assertCurrent: () => undefined, prepare });
  expect(Notice).toHaveBeenCalledWith('无法确认回答是否送达。为避免重复发送，未将其重新加入队列。');
  expect(submit).not.toHaveBeenCalled();
  expect(prepare.mock.calls[0][0].content).toContain('History');
});
