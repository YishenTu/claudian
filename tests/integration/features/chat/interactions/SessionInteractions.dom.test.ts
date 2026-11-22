/** @vitest-environment jsdom */
import '@/providers';

import { axe } from '@test/helpers/accessibility';
import { approvalDecisionOptions } from '@test/helpers/features/chat/approvalDecisionOptions';
import { createEvent, fireEvent, waitFor, within } from '@testing-library/dom';
import { Notice } from 'obsidian';

import type { ToolCallInfo } from '@/core/types';
import { deliverAsyncQuestion } from '@/features/chat/interactions/asyncQuestionDelivery';
import { createInteractionPromptPort } from '@/features/chat/interactions/interactionPromptPort';
import { SessionInteractions } from '@/features/chat/interactions/SessionInteractions';
import { setLocale, t } from '@/i18n/i18n';
import { ACPInteractionController } from '@/providers/acp/ACPInteractionController';
import { ClaudeExecutionInteractionRouter } from '@/providers/claude/execution/ClaudeExecutionInteractionRouter';
import { CodexExecutionServerRequestRouter } from '@/providers/codex/execution/CodexExecutionServerRequestRouter';

afterEach(() => { document.body.replaceChildren(); setLocale('en'); });

it('makes long approval details a named keyboard-scrollable region', async () => {
  const parent = document.body.createDiv();
  const suppressed = parent.createDiv();
  const prompts = new SessionInteractions({ getPromptParentEl: () => parent, getSuppressedEl: () => suppressed });
  const pending = prompts.requestApproval({
    interactionId: 'approval-id', toolName: 'Bash', description: 'A long command description', decisionOptions: approvalDecisionOptions(),
  });
  const details = within(parent).getByRole('region', { name: 'Bash approval details' });
  details.focus();
  expect(document.activeElement).toBe(details);
  const parentKeyDown = vi.fn();
  parent.addEventListener('keydown', parentKeyDown);
  for (const key of ['ArrowDown', 'Enter']) {
    const event = createEvent.keyDown(details, { key });
    fireEvent(details, event);
    expect(event.defaultPrevented).toBe(false);
  }
  expect(parentKeyDown).not.toHaveBeenCalled();
  expect(await axe(parent)).toHaveNoViolations();
  prompts.dismiss('approval-id');
  await pending;
});

it('ignores Enter on a fresh allow-first approval until the user moves to an option', async () => {
  const parent = document.body.createDiv();
  const prompts = new SessionInteractions({ getPromptParentEl: () => parent });
  // Native order as Codex and ACP providers send it: allow first.
  const decision = prompts.requestApproval({ interactionId: 'approval', toolName: 'Bash', description: 'Run the check', decisionOptions: [
    { decision: 'allow', label: 'Allow once', value: 'allow_once' },
    { decision: 'deny', label: 'Deny', value: 'reject_once' },
  ] });
  const region = within(parent).getByRole('region', { name: t('chat.approval.title') });
  await waitFor(() => expect(document.activeElement).toBe(region));
  expect(within(region).getAllByRole('button').map(button => button.getAttribute('aria-label'))).toEqual(['Allow once', 'Deny']);

  // A stray Enter, e.g. from the composer whose focus the panel just took.
  fireEvent.keyDown(region, { key: 'Enter' });
  expect(region.isConnected).toBe(true);
  expect(await axe(parent)).toHaveNoViolations();

  fireEvent.keyDown(region, { key: 'ArrowDown' });
  fireEvent.keyDown(region, { key: 'ArrowDown' });
  fireEvent.keyDown(region, { key: 'Enter' });
  await expect(decision).resolves.toBe('reject_once');
});

it('replies with the exact ACP option the user picks when several share a kind', async () => {
  const parent = document.body.createDiv();
  const prompts = new SessionInteractions({ getPromptParentEl: () => parent });
  const controller = new ACPInteractionController({
    getTurnId: () => 'turn', interactionPort: createInteractionPromptPort(() => prompts), sessionInstanceId: 'acp',
  });
  const reply = controller.requestPermission({
    options: [
      { kind: 'allow_once', name: 'Allow this file', optionId: 'allow-file' },
      { kind: 'allow_once', name: 'Allow this folder', optionId: 'allow-folder' },
      { kind: 'reject_once', name: 'Reject', optionId: 'reject' },
    ],
    sessionId: 'session', toolCall: { kind: 'edit', title: 'notes.md', toolCallId: 'tool' },
  });
  const region = within(parent).getByRole('region', { name: t('chat.approval.title') });
  expect(within(region).getAllByRole('button').map(button => button.getAttribute('aria-label')))
    .toEqual(['Allow this file', 'Allow this folder', 'Reject']);
  // Scripts still see each option's documented decision.
  expect(prompts.listPending()[0].questions[0].options.map(option => [option.value, option.decision]))
    .toEqual([['allow-file', 'allow'], ['allow-folder', 'allow'], ['reject', undefined]]);
  fireEvent.click(within(region).getByRole('button', { name: 'Allow this folder' }));
  await expect(reply).resolves.toEqual({ outcome: { outcome: 'selected', optionId: 'allow-folder' } });
});

it('accepts a scripted answer naming an offered option whose native id is blank', async () => {
  const parent = document.body.createDiv();
  const prompts = new SessionInteractions({ getPromptParentEl: () => parent });
  const controller = new ACPInteractionController({
    getTurnId: () => 'turn', interactionPort: createInteractionPromptPort(() => prompts), sessionInstanceId: 'acp',
  });
  const reply = controller.requestPermission({
    options: [
      { kind: 'allow_once', name: 'Allow', optionId: '' },
      { kind: 'reject_once', name: 'Reject', optionId: 'reject' },
    ],
    sessionId: 'session', toolCall: { kind: 'edit', title: 'notes.md', toolCallId: 'tool' },
  });
  const [pending] = prompts.listPending();
  const question = pending.questions[0];
  const offered = question.options.find(option => option.label === 'Allow')!;

  await prompts.answer(pending.interactionId, { [question.id ?? question.question]: offered.value });

  await expect(reply).resolves.toEqual({ outcome: { outcome: 'selected', optionId: '' } });
});

it('resumes the newest response when an older generation prompt settles last', async () => {
  const parent = document.body.createDiv();
  let generation = 1;
  const resumed: number[] = [];
  const prompts = new SessionInteractions({
    getPromptParentEl: () => parent,
    onBeforeShow: () => {
      const shownGeneration = generation;
      return () => resumed.push(shownGeneration);
    },
  });
  const question = { questions: [{ id: '0', question: 'Which check?', options: [{ label: 'History' }] }] };
  const first = prompts.askUserQuestion('first', question);
  generation = 2;
  const second = prompts.askUserQuestion('second', question);
  prompts.dismiss('second');
  await second;
  expect(resumed).toEqual([]);
  prompts.dismiss('first');
  await first;
  expect(resumed).toEqual([2]);
});

it('keeps an approval requested without a view pending until the user answers after attachment', async () => {
  let parent: HTMLElement | null = null;
  const prompts = new SessionInteractions({ getPromptParentEl: () => parent });
  let settled = false;
  const pending = prompts.requestApproval({
    interactionId: 'approval', toolName: 'Bash', description: 'Run the check', decisionOptions: approvalDecisionOptions(),
  }).finally(() => { settled = true; });
  void pending.catch(() => undefined);
  await Promise.resolve();
  await Promise.resolve();
  expect(settled).toBe(false);
  parent = document.body.createDiv();
  prompts.setActive(true);
  fireEvent.click(within(parent).getByRole('button', { name: 'Allow once' }));
  await expect(pending).resolves.toBe('Allow once');
});

it('keeps answer drafts and an in-flight submission across presentation disposal', async () => {
  let parent = document.body.createDiv();
  const prompts = new SessionInteractions({ getPromptParentEl: () => parent });
  let fail!: (error: Error) => void;
  const delivery = new Promise<void>((_resolve, reject) => { fail = reject; });
  const answer = vi.fn().mockReturnValueOnce(delivery).mockResolvedValue(undefined);
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
    sessionInstanceId: 'localized', getTurnId: () => 'turn', isToolAllowed: () => true, onToolBlocked: vi.fn(),
  });
  // Construct the adapter before selecting the locale to catch eagerly translated option arrays.
  const englishTitle = t('chat.approval.title');
  setLocale('zh-CN');
  const localizedTitle = t('chat.approval.title');
  expect(localizedTitle).not.toBe(englishTitle);
  const suggestions = [{ type: 'addDirectories' as const, directories: ['/outside'], destination: 'session' as const }];
  const input = { command: 'git status' };
  const result = router.canUseTool('Bash', input, {
    toolUseID: 'approval', requestId: 'request', signal: new AbortController().signal,
    ...(persistent ? { suggestions } : {}),
  });
  try {
    const region = within(parent).getByRole('region', { name: localizedTitle });
    expect(within(region).getByRole('region', { name: t('chat.approval.details', { tool: 'Bash' }) }).textContent)
      .toBe(t('chat.approval.runCommand', { pattern: 'git status' }));
    expect(within(region).getByRole('button', { name: t('chat.approval.deny') })).toBeDefined();
    expect(within(region).queryByRole('button', { name: t('chat.approval.alwaysAllow') }) !== null).toBe(persistent);
    expect(await axe(region)).toHaveNoViolations();
    fireEvent.click(within(region).getByRole('button', { name: persistent ? t('chat.approval.alwaysAllow') : t('chat.approval.allowOnce') }));
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
  ['rejected', 'chat.questions.notSent'],
  ['unsupported', 'chat.questions.unsupportedReply'],
] as const)('shows a localized %s delivery failure in the real question panel', async (failure, expectedKey) => {
  const englishMessage = t(expectedKey);
  setLocale('zh-CN');
  const expected = t(expectedKey);
  expect(expected).not.toBe(englishMessage);
  const parent = document.body.createDiv();
  const prompts = new SessionInteractions({ getPromptParentEl: () => parent });
  const tool: ToolCallInfo = { id: 'question', name: 'AskUserQuestion', status: 'completed', questionStatus: 'pending', input: {
    replyMode: 'user-message', questions: [{ id: '0', question: 'Which check?', options: [{ label: 'History' }] }],
  } };
  const steer = vi.fn(async (onDelivery: (accepted: boolean) => void) => { onDelivery(false); return 'accepted' as const; });
  const submit = vi.fn();
  const pending = prompts.askUserQuestion('question', tool.input, undefined, {
    onSubmit: answers => deliverAsyncQuestion(tool, answers, {
      providerId: failure === 'unsupported' ? 'claude' : 'codex', assertCurrent: () => undefined,
      prepare: () => ({ steer, submit }),
    }),
  });
  try {
    const region = within(parent).getByRole('region', { name: t('chat.questions.title') });
    fireEvent.click(within(region).getByRole('button', { name: 'History' }));
    fireEvent.click(within(region).getByRole('button', { name: t('chat.questions.submitAnswers') }));
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
  const englishNotice = t('chat.questions.uncertainDelivery');
  setLocale('zh-CN');
  const localizedNotice = t('chat.questions.uncertainDelivery');
  expect(localizedNotice).not.toBe(englishNotice);
  const tool: ToolCallInfo = { id: 'question', name: 'AskUserQuestion', status: 'completed', questionStatus: 'pending', input: {
    replyMode: 'user-message', questions: [{ id: '0', question: 'Which check?', options: [{ label: 'History' }] }],
  } };
  const submit = vi.fn();
  const prepare = vi.fn((_reply: { content: string }) => ({ steer: async () => 'uncertain' as const, submit }));
  await deliverAsyncQuestion(tool, { '0': 'History' }, { providerId: 'codex', assertCurrent: () => undefined, prepare });
  expect(Notice).toHaveBeenCalledWith(localizedNotice);
  expect(submit).not.toHaveBeenCalled();
  expect(prepare.mock.calls[0][0].content).toContain('History');
});


it.each([false, true])('honors Codex isSecret=%s during answer review and delivers the original value', async isSecret => {
  const parent = document.body.createDiv();
  const prompts = new SessionInteractions({ getPromptParentEl: () => parent });
  const turn = {
    localTurnId: 'local-turn', nativeThreadId: 'thread', nativeTurnId: 'turn',
    toolPolicy: { kind: 'provider-default' } as const, cancellation: new AbortController(),
  };
  const router = new CodexExecutionServerRequestRouter('session', createInteractionPromptPort(() => prompts), () => true, () => turn);
  const pending = router.handleServerRequest('request', 'item/tool/requestUserInput', {
    threadId: 'thread', turnId: 'turn', itemId: 'item', questions: [{
      id: 'token', header: 'Token', question: 'Enter API token', options: null, isOther: true, isSecret,
    }],
  });
  try {
    const region = within(parent).getByRole('region', { name: 'Question' });
    const input = within(region).getByLabelText('Enter API token');
    expect(input.getAttribute('type')).toBe(isSecret ? 'password' : 'text');
    const answer = 'sample-sensitive-token-123';
    fireEvent.input(input, { target: { value: answer } });
    fireEvent.click(within(region).getByRole('button', { name: 'Submit' }));
    expect(within(region).getByText('Review your answers')).toBeDefined();
    const review = within(region).getByRole('button', { name: 'Edit answer to Enter API token' });
    expect(review.textContent).toContain(isSecret ? '••••••••' : answer);
    expect(region.textContent?.includes(answer)).toBe(!isSecret);
    expect(await axe(region)).toHaveNoViolations();

    // Editing the masked review preserves the underlying answer in its original input type.
    fireEvent.click(review);
    const restoredInput = within(region).getByLabelText('Enter API token') as HTMLInputElement;
    expect(restoredInput.type).toBe(isSecret ? 'password' : 'text');
    expect(restoredInput.value).toBe(answer);
    fireEvent.click(within(region).getByRole('button', { name: 'Submit' }));
    fireEvent.click(within(region).getByRole('button', { name: 'Submit answers' }));
    await expect(pending).resolves.toEqual({ answers: { token: { answers: [answer] } } });
  } finally {
    router.abortAll('cancelled');
    await pending;
  }
});
