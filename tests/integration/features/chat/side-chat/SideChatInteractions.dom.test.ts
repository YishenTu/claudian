/** @vitest-environment jsdom */
import '@/providers';

import { axe } from '@test/helpers/accessibility';
import { deferred } from '@test/helpers/ChatInputHarness';
import { createTestSession } from '@test/helpers/ConversationPorts';
import { createHarness, releaseSideChatHarnesses, startSideChat } from '@test/helpers/features/chat/SideChatDOMHarness';
import { fireEvent, screen, waitFor } from '@testing-library/dom';
import { Component, MarkdownRenderer, Notice } from 'obsidian';

import type { ProviderExecutionRequest } from '@/core/execution';
import { ProviderRegistry } from '@/core/providers/ProviderRegistry';
import { InputController, type InputControllerDeps } from '@/features/chat/input/InputController';
import { SessionInteractions } from '@/features/chat/interactions/SessionInteractions';
import { ChatState } from '@/features/chat/state/ChatState';
import { formatCodexQuestionReply } from '@/providers/codex/normalization/codexQuestionNormalization';

const taskResultInterpreter = ProviderRegistry.getTaskResultInterpreter('claude');

afterEach(async () => {
  try { await releaseSideChatHarnesses(); } finally { vi.useRealTimers(); }
});

it('keeps a child turn and detached approval alive, then restores the completed transcript', async () => {
  vi.mocked(MarkdownRenderer.render).mockImplementation(async (_app, text, el) => { el.textContent = text; });
  const harness = createHarness();
  const { started } = await startSideChat(harness);
  const runtime = harness.controller.runtime!;
  const native = harness.backend.latest;
  native.emitText('Before ');
  await waitFor(() => expect(runtime.state.currentTextContent).toBe('Before '));
  runtime.detachPresentation();
  harness.composerEl.remove();
  native.emitText('detachment.');
  await waitFor(() => expect(runtime.state.currentTextContent).toBe('Before detachment.'));
  const pending = native.config.interactionPort.requestApproval({
    interactionId: 'detached-approval', sessionInstanceId: native.sessionInstanceId,
    turnId: native.activeTurnId, kind: 'approval', toolName: 'Read', input: {}, description: 'Read while detached',
  }, new AbortController().signal);
  let settled = false;
  void pending.then(() => { settled = true; });
  await Promise.resolve();
  expect(settled).toBe(false);
  expect(runtime.state.requiresAction).toBe(true);
  const root = document.body.createDiv();
  const messagesEl = root.createDiv();
  runtime.attachPresentation({ component: new Component(), messagesEl, getPromptParentEl: () => root });
  fireEvent.click(screen.getByRole('button', { name: 'Allow once' }));
  await expect(pending).resolves.toMatchObject({ decision: 'allow' });
  native.emitText(' Reattached.');
  native.complete();
  await started;
  expect(native.cancelCalls).toBe(0);
  expect(runtime.state.messages.at(-1)?.contentBlocks).toEqual([{ type: 'text', content: 'Before detachment. Reattached.' }]);
  runtime.detachPresentation();
  root.remove();
  const completedRoot = document.body.createDiv();
  runtime.attachPresentation({ component: new Component(), messagesEl: completedRoot, getPromptParentEl: () => completedRoot });
  await waitFor(() => expect(completedRoot.textContent).toContain('Before detachment. Reattached.'));
  const followUp = runtime.submit({ content: 'Continue after reattachment' });
  await waitFor(() => expect(native.requests).toHaveLength(2));
  expect(native.requests[1].conversationHistory?.slice(0, 2).map(message => message.content)).toEqual(['Remember A', 'Noted A']);
  native.complete();
  await followUp;
});

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

/** Starts a later side turn while the first turn's question is still open. */
async function startLaterTurnUnderQuestion() {
  const result = await showAsyncQuestion();
  vi.useFakeTimers();
  const { harness, native, started } = result;
  const steer = vi.fn(async (_request: ProviderExecutionRequest) => true);
  Object.assign(native, { steer });
  native.complete();
  await started;
  const later = harness.controller.runtime!.submit({ content: 'Later work' });
  await vi.waitFor(() => expect(native.requests).toHaveLength(2));
  return { ...result, later };
}

const waitingIndicator = () => document.querySelector('.claudian-side-chat-messages .claudian-thinking');

it('shows the later side turn waiting indicator once the earlier turn question settles', async () => {
  const { native, later } = await startLaterTurnUnderQuestion();
  await vi.advanceTimersByTimeAsync(500);
  expect(screen.getByRole('region', { name: 'Question' })).toBeTruthy();
  expect(waitingIndicator()).toBeNull();
  submitAnswer();
  await vi.waitFor(() => expect(screen.queryByRole('region', { name: 'Question' })).toBeNull());
  await vi.waitFor(() => expect(waitingIndicator()).not.toBeNull());
  native.complete();
  await later;
});

it('does not resurrect the waiting indicator when the earlier question settles after the later turn started streaming', async () => {
  const { harness, native, later } = await startLaterTurnUnderQuestion();
  await vi.advanceTimersByTimeAsync(500);
  native.emitText('Working on it');
  await vi.waitFor(() => expect(harness.controller.runtime!.state.currentTextContent).toContain('Working on it'));
  submitAnswer();
  await vi.waitFor(() => expect(screen.queryByRole('region', { name: 'Question' })).toBeNull());
  await vi.advanceTimersByTimeAsync(600);
  expect(waitingIndicator()).toBeNull();
  native.complete();
  await later;
});

it('submits an async answer to the active side turn while preserving queued work and the composer draft', async () => {
  const { harness, native, started } = await showAsyncQuestion();
  const steer = vi.fn(async (_request: ProviderExecutionRequest) => true);
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

it.each([['before', 'requested'], ['after', 'requested'], ['before', 'background'], ['after', 'background']] as const)('keeps a steered answer before its response when acknowledgement arrives %s the %s echo', async (acknowledgement, channel) => {
  vi.mocked(MarkdownRenderer.render).mockImplementation(async (_app, text, el) => { el.textContent = text; });
  const { harness, native, started } = await showAsyncQuestion();
  native.emitOutput({ type: 'user_message_started', content: 'Explore B' });
  native.emitOutput({ type: 'assistant_message_started' });
  native.emitText('Before the answer.');
  await waitFor(() => expect(harness.controller.runtime!.state.currentTextContent).toBe('Before the answer.'));
  const handoff = deferred<boolean>();
  const steer = vi.fn((_request: ProviderExecutionRequest) => handoff.promise);
  Object.assign(native, { steer });
  submitAnswer();
  await waitFor(() => expect(steer).toHaveBeenCalledTimes(1));
  const answerText = (steer.mock.calls[0][0].input[0] as { text: string }).text;
  const waitForQuestionToClose = () => waitFor(() => expect(screen.queryByRole('region', { name: 'Question' })).toBeNull());
  const waitForResponse = () => waitFor(() => expect(screen.getByText('After the answer.')).toBeTruthy());
  if (acknowledgement === 'before') {
    handoff.resolve(true);
    await waitForQuestionToClose();
  }
  if (channel === 'requested') {
    native.emitOutput({ type: 'user_message_started', content: answerText, nativeUserMessageId: 'native-answer' });
    native.emitOutput({ type: 'assistant_message_started' });
    native.emitText('After the answer.');
  } else {
    native.complete();
    await started;
    native.emitBackgroundEvent({ type: 'background_turn_started' });
    native.emitBackgroundEvent({ type: 'user_message_started', content: answerText, nativeUserMessageId: 'native-answer' });
    native.emitBackgroundEvent({ type: 'assistant_message_started' });
    native.emitBackgroundEvent({ type: 'text_delta', text: 'After the answer.' });
    native.emitBackgroundEvent({ type: 'background_turn_completed', reason: 'completed' });
  }
  if (acknowledgement === 'after') {
    await waitForResponse();
    handoff.resolve(true);
    await waitForQuestionToClose();
  }
  native.complete();
  await started;
  await waitFor(() => expect(harness.controller.runtime!.isWorking).toBe(false));
  const messages = harness.controller.runtime!.state.messages;
  const answers = messages.filter(message => message.role === 'user' && message.content === answerText);
  expect(answers).toHaveLength(1);
  const answerIndex = messages.indexOf(answers[0]);
  expect(messages.slice(0, answerIndex).some(message => message.contentBlocks?.some(block => block.type === 'text' && block.content === 'Before the answer.'))).toBe(true);
  expect(messages.slice(answerIndex + 1).some(message => message.contentBlocks?.some(block => block.type === 'text' && block.content === 'After the answer.'))).toBe(true);
  const answerElement = screen.getByText('Before the answer.').closest('.claudian-message')!;
  expect(harness.composerEl.querySelector(`[data-message-id="${answers[0].id}"]`)).toBeNull();
  const responseElement = screen.getByText('After the answer.').closest('.claudian-message')!;
  expect(answerElement.compareDocumentPosition(responseElement) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(native.requests).toHaveLength(1);
  expect(await axe(harness.composerEl)).toHaveNoViolations();
  const followUp = harness.controller.submitToSide('Continue with that answer', []);
  await waitFor(() => expect(native.requests).toHaveLength(2));
  const history = native.requests[1].conversationHistory!;
  const historicalAnswer = history.findIndex(message => message.content === answerText);
  expect(history.slice(historicalAnswer + 1).some(message => message.contentBlocks?.some(block => block.type === 'text' && block.content === 'After the answer.'))).toBe(true);
  native.complete();
  await followUp;
});

it.each(['rejected', 'ambiguous'] as const)('keeps an echoed side answer accepted after a later %s acknowledgement', async outcome => {
  const { harness, native, started } = await showAsyncQuestion();
  native.emitOutput({ type: 'user_message_started', content: 'Explore B' });
  const handoff = deferred<boolean>();
  const steer = vi.fn((_request: ProviderExecutionRequest) => handoff.promise);
  Object.assign(native, { steer });
  submitAnswer();
  await waitFor(() => expect(steer).toHaveBeenCalledTimes(1));
  const answerText = (steer.mock.calls[0][0].input[0] as { text: string }).text;
  native.emitOutput({ type: 'user_message_started', content: answerText });
  native.emitOutput({ type: 'assistant_message_started' });
  native.emitText('The answer was received.');
  await waitFor(() => expect(harness.controller.runtime!.state.currentTextContent).toBe('The answer was received.'));
  if (outcome === 'rejected') handoff.resolve(false);
  else handoff.reject(new Error('Acknowledgement lost'));
  await waitFor(() => expect(screen.queryByRole('region', { name: 'Question' })).toBeNull());
  expect(harness.controller.runtime!.queuedCount).toBe(0);
  expect(harness.controller.runtime!.state.messages.filter(message => message.role === 'user' && message.content === answerText)).toHaveLength(1);
  native.complete();
  await started;
  expect(native.requests).toHaveLength(1);
});

it.each(['rejected', 'ambiguous'] as const)('settles a %s side answer without leaving the prompt busy', async outcome => {
  const { harness, native, started } = await showAsyncQuestion();
  const steer = outcome === 'rejected' ? vi.fn().mockResolvedValue(false) : vi.fn().mockRejectedValue(new Error('Acknowledgement lost'));
  Object.assign(native, { steer });
  submitAnswer();
  await waitFor(() => expect(screen.queryByRole('region', { name: 'Question' })).toBeNull());
  expect(steer).toHaveBeenCalledTimes(1);
  expect(harness.controller.runtime!.queuedCount).toBe(outcome === 'rejected' ? 1 : 0);
  expect(native.requests).toHaveLength(1);
  expect(vi.mocked(Notice).mock.calls.some(([message]) => String(message).includes('could not be confirmed'))).toBe(outcome === 'ambiguous');
  harness.controller.cancelSide();
  await started;
});

it.each(['completed', 'cancelled'] as const)('handles a side turn that is %s before its answer steer is rejected', async outcome => {
  const { harness, native, started } = await showAsyncQuestion();
  const handoff = deferred<boolean>();
  const steer = vi.fn(() => handoff.promise);
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
  const harness = createHarness({ onDestinationChanged: () => prompts.setActive(harness.controller.destination === 'main') });
  const session = createTestSession();
  const state = new ChatState({}, undefined, session.turns);
  const prompts = new SessionInteractions({
    getPromptParentEl: () => harness.inputContainerEl.parentElement,
    getSuppressedEl: () => harness.inputContainerEl,
  });
  const main = new InputController({
    state, session, inlinePrompts: prompts,
    streamController: { thinkingIndicator: { hide: vi.fn() } },
    renderer: { updateQuestionTool: vi.fn() },
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

it.each(['accepted', 'rejected', 'ambiguous'] as const)('accepts an echoed side answer before rendering settles despite a %s acknowledgement', async outcome => {
  const render = deferred<void>();
  const rendering = deferred<void>();
  vi.mocked(MarkdownRenderer.render).mockImplementation(async (_app, text, el) => {
    el.textContent = text;
    if (text === 'Before the answer.') { rendering.resolve(); await render.promise; }
  });
  const { harness, native, started } = await showAsyncQuestion();
  const handoff = deferred<boolean>();
  const steer = vi.fn((_request: ProviderExecutionRequest) => handoff.promise);
  Object.assign(native, { steer });
  try {
    native.emitOutput({ type: 'user_message_started', content: 'Explore B' });
    native.emitOutput({ type: 'assistant_message_started' });
    native.emitText('Before the answer.');
    await waitFor(() => expect(harness.controller.runtime!.state.currentTextContent).toBe('Before the answer.'));
    submitAnswer();
    await waitFor(() => expect(steer).toHaveBeenCalledTimes(1));
    const answerText = (steer.mock.calls[0][0].input[0] as { text: string }).text;
    native.emitOutput({ type: 'user_message_started', content: answerText, nativeUserMessageId: 'native-answer' });
    await rendering.promise;
    await waitFor(() => expect(harness.controller.runtime!.state.currentTextContent).toBe(''));
    if (outcome === 'ambiguous') handoff.reject(new Error('Acknowledgement lost'));
    else handoff.resolve(outcome === 'accepted');
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Question' })).toBeNull());
    expect(harness.controller.runtime!.queuedCount).toBe(0);
    expect(vi.mocked(Notice).mock.calls.some(([message]) => String(message).includes('could not be confirmed'))).toBe(false);
  } finally {
    render.resolve(); harness.controller.runtime!.cancel(); native.complete(); await started;
  }
});
