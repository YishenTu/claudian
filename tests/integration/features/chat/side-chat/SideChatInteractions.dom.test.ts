/** @jest-environment jsdom */
import '@/providers';

import { deferred } from '@test/helpers/ChatInputHarness';
import { createHarness, releaseSideChatHarnesses, startSideChat } from '@test/helpers/features/chat/SideChatDOMHarness';
import { fireEvent, screen, waitFor } from '@testing-library/dom';
import { axe } from 'jest-axe';
import { Notice } from 'obsidian';

import type { ProviderExecutionRequest } from '@/core/execution';
import { ProviderRegistry } from '@/core/providers/ProviderRegistry';
import { InputController, type InputControllerDeps } from '@/features/chat/controllers/InputController';
import { ChatState } from '@/features/chat/state/ChatState';
import { formatCodexQuestionReply } from '@/providers/codex/normalization/codexQuestionNormalization';

const taskResultInterpreter = ProviderRegistry.getTaskResultInterpreter('claude');

afterEach(releaseSideChatHarnesses);

it('keeps replacement approval attention after a dismissed prompt with the same id settles', async () => {
  const harness = createHarness();
  const { started } = await startSideChat(harness);
  harness.controller.expand();
  const native = harness.backend.latest;
  const port = native.config.interactionPort;
  const request = (description: string) => port.requestApproval({
    interactionId: 'reused', sessionInstanceId: native.sessionInstanceId, turnId: native.activeTurnId,
    kind: 'approval', toolName: 'Read', description, input: {},
  }, new AbortController().signal);
  const first = request('First request').catch(() => null);
  expect(screen.getByText('First request')).toBeTruthy();
  port.dismissInteraction('reused', 'superseded');
  const replacement = request('Replacement request');
  await first;
  expect(screen.getByText('Replacement request')).toBeTruthy();
  expect(harness.controller.runtime!.state.requiresAction).toBe(true);
  fireEvent.click(screen.getByText('Allow once', { exact: true }));
  await expect(replacement).resolves.toMatchObject({ decision: 'allow' });
  expect(harness.controller.runtime!.state.requiresAction).toBe(false);
  native.complete();
  await started;
});

it.each(['approval', 'question'] as const)('dismisses only the named overlapping %s', async kind => {
  const harness = createHarness();
  const { started } = await startSideChat(harness);
  harness.controller.expand();
  const native = harness.backend.latest;
  const port = native.config.interactionPort;
  const request = (interactionId: string) => {
    const common = { interactionId, sessionInstanceId: native.sessionInstanceId, turnId: native.activeTurnId };
    return kind === 'approval'
      ? port.requestApproval({ ...common, kind, toolName: interactionId, description: `${interactionId} details`, input: {} }, new AbortController().signal)
      : port.askUserQuestion({ ...common, kind, input: { questions: [{ question: `${interactionId} question`, options: [{ label: 'Yes', description: '' }] }] } }, new AbortController().signal);
  };
  const first = request('first').catch(() => null);
  const second = request('second').catch(() => null);
  await waitFor(() => expect(screen.getByText(kind === 'approval' ? 'second details' : 'second question')).toBeTruthy());
  port.dismissInteraction('first', 'native-rejected');
  expect(screen.queryByText(kind === 'approval' ? 'first details' : 'first question')).toBeNull();
  expect(screen.getByText(kind === 'approval' ? 'second details' : 'second question')).toBeTruthy();
  port.dismissInteraction('second', 'native-rejected');
  await Promise.all([first, second]);
  expect(screen.queryByText(kind === 'approval' ? 'second details' : 'second question')).toBeNull();
  native.complete();
  await started;
});

it('completing one approval leaves the other reachable for cancellation', async () => {
  const harness = createHarness();
  const { started } = await startSideChat(harness);
  harness.controller.expand();
  const native = harness.backend.latest;
  const port = native.config.interactionPort;
  const request = (interactionId: string) => port.requestApproval({
    interactionId, sessionInstanceId: native.sessionInstanceId, turnId: native.activeTurnId,
    kind: 'approval', toolName: interactionId, description: `${interactionId} details`, input: {},
  }, new AbortController().signal);
  const first = request('first');
  const second = request('second').catch(() => null);
  await waitFor(() => expect(screen.getAllByText('Allow once', { exact: true })).toHaveLength(2));
  const prompt = screen.getByRole('region', { name: 'first approval details' }).closest<HTMLElement>('.claudian-ask-question-inline')!;
  expect(await axe(prompt)).toHaveNoViolations();
  fireEvent.click(screen.getAllByText('Allow once', { exact: true })[0]);
  await expect(first).resolves.toMatchObject({ decision: 'allow', interactionId: 'first' });
  port.dismissInteraction('second', 'cancelled');
  expect(screen.queryByRole('region', { name: 'second approval details' })).toBeNull();
  await second;
  native.complete();
  await started;
});


async function showAsyncQuestion() {
  const harness = createHarness({ formatQuestionReply: formatCodexQuestionReply, taskResultInterpreter });
  const { started } = await startSideChat(harness);
  harness.controller.expand();
  const native = harness.backend.latest;
  native.emitOutput({ type: 'tool_started', toolCallId: 'ask', toolScope: { kind: 'main' }, name: 'AskUserQuestion', input: {
    replyMode: 'user-message', questions: [{ id: '0', question: 'Which check?', options: [{ label: 'History' }] }],
  } });
  native.emitOutput({ type: 'tool_completed', toolCallId: 'ask', toolScope: { kind: 'main' }, content: 'Question sent. Awaiting your reply.' });
  await waitFor(() => expect(screen.getByRole('button', { name: 'History' })).toBeTruthy());
  const question = screen.getByRole('region', { name: 'Question' });
  expect(question.closest('.claudian-side-chat-prompts')).not.toBeNull();
  expect(question.closest('.claudian-tool-call')).toBeNull();
  expect(document.querySelector('.claudian-input-composer')?.classList.contains('claudian-side-chat-prompt')).toBe(true);
  return { harness, native, started };
}

function submitAnswer() {
  fireEvent.click(screen.getByRole('button', { name: 'History' }));
  fireEvent.click(screen.getByRole('button', { name: 'Submit answers' }));
}

async function queueQuestionReply() {
  const result = await showAsyncQuestion();
  const { harness, native } = result;
  submitAnswer();
  await waitFor(() => expect(screen.queryByRole('region', { name: 'Question' })).toBeNull());
  expect(harness.controller.runtime!.queuedCount).toBe(1);
  await waitFor(() => expect(harness.composerEl.classList.contains('claudian-side-chat-prompt')).toBe(false));
  expect(native.requests).toHaveLength(1);
  return result;
}

it.each(['asking', 'later'] as const)('keeps an unanswered side question usable after stopping the %s turn', async cancelledTurn => {
  const { harness, native, started } = await showAsyncQuestion();
  const runtime = harness.controller.runtime!;
  const tool = runtime.state.messages.flatMap(message => message.toolCalls ?? []).find(tool => tool.id === 'ask')!;
  fireEvent.click(screen.getByRole('button', { name: 'History' }));
  let stopped: Promise<unknown> = started;
  if (cancelledTurn === 'later') {
    native.complete();
    await started;
    stopped = runtime.submit({ content: 'Later work' });
  }
  await waitFor(() => expect(native.requests).toHaveLength(cancelledTurn === 'later' ? 2 : 1));
  harness.controller.cancelSide();
  await stopped;
  expect(tool.questionStatus).toBe('pending');
  expect(screen.getByRole('region', { name: 'Question' })).toBeTruthy();
  expect(runtime.state.requiresAction).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Submit answers' }));
  await waitFor(() => expect(native.requests).toHaveLength(cancelledTurn === 'later' ? 3 : 2));
  expect(native.requests.at(-1)!.input).toEqual([{ type: 'text', text: expect.stringContaining('"answer":"History"') }]);
  await waitFor(() => expect(screen.queryByRole('region', { name: 'Question' })).toBeNull());
  expect(tool.resolvedAnswers).toEqual({ '0': 'History' });
  native.complete();
});

it('submits an async answer to the active side turn while preserving queued work and the composer draft', async () => {
  const { harness, native, started } = await showAsyncQuestion();
  const steer = jest.fn(async (_request: ProviderExecutionRequest) => true);
  Object.assign(native, { steer });
  harness.controller.runtime!.enqueue({ content: 'Unrelated follow-up' });
  harness.inputEl.value = 'Keep this draft';
  submitAnswer();
  await waitFor(() => expect(screen.queryByRole('region', { name: 'Question' })).toBeNull());
  expect(steer).toHaveBeenCalledTimes(1);
  const text = (steer.mock.calls[0][0].input[0] as { text: string }).text;
  expect(JSON.parse(text.split('\n')[1])).toEqual([{
    questionItemId: '["request_user_input_async","ask",0]', question: 'Which check?', answer: 'History',
  }]);
  expect(native.requests).toHaveLength(1);
  expect(native.cancelCalls).toBe(0);
  expect(harness.controller.runtime!.queuedCount).toBe(1);
  expect(harness.inputEl.value).toBe('Keep this draft');
  expect(harness.controller.runtime!.state.isStreaming).toBe(true);
  native.complete();
  await waitFor(() => expect(native.requests).toHaveLength(2));
  expect(native.requests[1].input).toEqual([{ type: 'text', text: 'Unrelated follow-up' }]);
  native.complete();
  await started;
});

it.each(['rejected', 'ambiguous'] as const)('settles a %s side answer without leaving the prompt busy', async outcome => {
  const { harness, native, started } = await showAsyncQuestion();
  const steer = outcome === 'rejected' ? jest.fn().mockResolvedValue(false) : jest.fn().mockRejectedValue(new Error('Acknowledgement lost'));
  Object.assign(native, { steer });
  submitAnswer();
  await waitFor(() => expect(screen.queryByRole('region', { name: 'Question' })).toBeNull());
  expect(steer).toHaveBeenCalledTimes(1);
  expect(harness.controller.runtime!.queuedCount).toBe(outcome === 'rejected' ? 1 : 0);
  expect(native.requests).toHaveLength(1);
  expect(jest.mocked(Notice).mock.calls.some(([message]) => String(message).includes('could not be confirmed'))).toBe(outcome === 'ambiguous');
  harness.controller.cancelSide();
  await started;
});

it.each(['completed', 'cancelled'] as const)('handles a side turn that is %s before its answer steer is rejected', async outcome => {
  const { harness, native, started } = await showAsyncQuestion();
  const handoff = deferred<boolean>();
  const steer = jest.fn(() => handoff.promise);
  Object.assign(native, { steer });
  submitAnswer();
  await waitFor(() => expect(steer).toHaveBeenCalledTimes(1));
  if (outcome === 'completed') native.complete();
  else harness.controller.cancelSide();
  await started;
  handoff.resolve(false);
  await waitFor(() => expect(screen.queryByRole('region', { name: 'Question' })).toBeNull());
  await waitFor(() => expect(native.requests).toHaveLength(outcome === 'completed' ? 2 : 1));
  const expectedInput = [{ type: 'text', text: expect.stringContaining('<send_user_message_question_reply>') }];
  expect(native.requests[1]?.input).toEqual(outcome === 'completed'
    ? expectedInput : undefined);
  expect(harness.controller.runtime!.queuedCount).toBe(0);
  if (outcome === 'completed') native.complete();
});

it('withdraws an idle side answer that expires during configuration', async () => {
  const { harness, native, started } = await showAsyncQuestion();
  native.complete();
  await started;
  const runtime = harness.controller.runtime!;
  const tool = runtime.state.messages.flatMap(message => message.toolCalls ?? []).find(tool => tool.id === 'ask')!;
  const preparing = deferred<string[]>();
  const prepare = jest.fn(() => preparing.promise);
  Object.assign(harness.plugin, { getMainAgentDynamicSystemPromptSections: prepare });
  const execute = native.execute.bind(native);
  jest.spyOn(native, 'execute').mockImplementation(request => {
    const run = execute(request);
    native.complete();
    return run;
  });
  const submit = jest.spyOn(runtime, 'submit');
  harness.inputEl.value = 'Keep this draft';
  submitAnswer();
  await waitFor(() => expect(prepare).toHaveBeenCalledTimes(1));
  tool.questionStatus = 'expired';
  preparing.resolve([]);
  await submit.mock.results[0].value;
  expect(native.requests).toHaveLength(1);
  expect(harness.inputEl.value).toBe('Keep this draft');
  expect(runtime.queuedCount).toBe(0);
});

it('discards a locally queued reply on cancellation without leaving Sending or delivering it later', async () => {
  const { harness, native, started } = await queueQuestionReply();
  harness.controller.cancelSide();
  await started;
  expect(screen.queryByRole('region', { name: 'Question' })).toBeNull();
  expect(harness.controller.runtime!.queuedCount).toBe(0);
  expect(native.requests).toHaveLength(1);
});

it('closes the panel on queue admission, delivers later, and keeps it closed after a response error', async () => {
  const { harness, native, started } = await queueQuestionReply();
  harness.controller.collapse();
  expect(harness.composerEl.classList.contains('claudian-side-chat-prompt')).toBe(false);
  harness.controller.expand();
  expect(harness.composerEl.classList.contains('claudian-side-chat-prompt')).toBe(false);
  native.complete();
  await waitFor(() => expect(native.requests).toHaveLength(2));
  expect(native.requests[1].input).toEqual([{ type: 'text', text: expect.stringContaining('<send_user_message_question_reply>') }]);
  const text = (native.requests[1].input[0] as { text: string }).text;
  expect(JSON.parse(text.split('\n')[1])).toEqual([{ questionItemId: '["request_user_input_async","ask",0]', question: 'Which check?', answer: 'History' }]);
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Sending...' })).toBeNull());
  await waitFor(() => expect(harness.composerEl.classList.contains('claudian-side-chat-prompt')).toBe(false));
  native.fail('Response failed after acceptance');
  await started;
  expect(screen.queryByRole('button', { name: 'Submit answers' })).toBeNull();
  expect(native.requests).toHaveLength(2);
  expect(document.querySelectorAll('.claudian-side-chat-messages .claudian-message-user')).toHaveLength(1);
});


it('keeps a pending main question out of the side destination and restores its answers on return', async () => {
  const harness = createHarness({ onDestinationChanged: () => main.setPromptActive(harness.controller.destination === 'main') });
  const state = new ChatState();
  const main = new InputController({
    state, getInputContainerEl: () => harness.inputContainerEl,
    streamController: { hideThinkingIndicator: jest.fn(), resumeThinkingIndicator: jest.fn() },
    renderer: { updateQuestionTool: jest.fn() },
  } as unknown as InputControllerDeps);
  try {
    const { started } = await startSideChat(harness);
    harness.backend.latest.complete();
    await started;
    harness.controller.collapse();
    main.updateAsyncQuestion({ id: 'main-question', name: 'AskUserQuestion', status: 'completed', input: {
      replyMode: 'user-message', questions: [{ question: 'Main question?', options: [{ label: 'Main answer' }] }],
    } });
    fireEvent.click(screen.getByRole('button', { name: 'Main answer' }));
    expect(harness.inputContainerEl.classList.contains('claudian-hidden')).toBe(true);
    harness.controller.expand();
    expect(harness.inputContainerEl.classList.contains('claudian-hidden')).toBe(false);
    expect(screen.queryByRole('region', { name: 'Question' })).toBeNull();
    expect(state.requiresAction).toBe(true);
    harness.controller.collapse();
    expect(harness.inputContainerEl.classList.contains('claudian-hidden')).toBe(true);
    expect(screen.getByRole('button', { name: 'Submit answers' })).toBeDefined();
    expect(screen.getByText('Main answer')).toBeDefined();
  } finally {
    main.dismissPendingApproval();
  }
});
