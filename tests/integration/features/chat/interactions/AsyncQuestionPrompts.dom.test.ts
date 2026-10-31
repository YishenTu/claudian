/** @vitest-environment jsdom */
import '@/providers';

import { axe } from '@test/helpers/accessibility';
import { createHarness as createExecutionHarness, requestedScope } from '@test/helpers/ChatExecutionHarness';
import { createFixture, deferred } from '@test/helpers/ChatInputHarness';
import { testDate } from '@test/helpers/testClock';
import { fireEvent, waitFor, within } from '@testing-library/dom';

import type { ChatMessage, ToolCallInfo } from '@/core/types';

const cleanups: Array<() => void> = [];
afterEach(() => {
  cleanups.splice(0).forEach(cleanup => cleanup());
  document.body.replaceChildren();
});

it.each(['asking', 'later'] as const)('keeps an unanswered question usable after stopping the %s turn', async cancelledTurn => {
  const host = document.body.createDiv();
  const composer = host.createDiv();
  const execution = createExecutionHarness({ onRequestedEvent: event => fixture.controller.handleExecutionEvent(event) });
  const fixture = (await createFixture({
    getTabProviderId: () => 'codex', getInputContainerEl: () => composer,
    getExecutionCoordinator: () => execution.coordinator,
  }));
  await execution.coordinator.bindConversation({ conversationId: 'conversation-1', providerId: 'codex' });
  const running = fixture.controller.sendMessage({ content: 'Start work' });
  const backend = execution.backends.get('codex')!;
  await waitFor(() => expect(backend.sessions[0]?.runs).toHaveLength(1));
  const native = backend.sessions[0];
  const run = native.runs[0];
  const tool: ToolCallInfo = { id: 'ask', name: 'AskUserQuestion', status: 'completed', input: {
    replyMode: 'user-message', questions: [{ id: '0', question: 'Which check?', options: [{ label: 'History' }] }],
  } };
  fixture.state.messages.at(-1)!.toolCalls = [tool];
  fixture.controller.updateAsyncQuestion(tool);
  fireEvent.click(within(host).getByRole('button', { name: 'History' }));
  let stopped = running;
  if (cancelledTurn === 'later') {
    run.events.push({ type: 'turn_completed', reason: 'completed', scope: requestedScope(native, run, 1) });
    run.events.end();
    await running;
    stopped = fixture.controller.sendMessage({ content: 'Later work' });
  }
  await waitFor(() => expect(native.runs).toHaveLength(cancelledTurn === 'later' ? 2 : 1));
  fixture.controller.cancelStreaming();
  await stopped;
  try {
    expect(tool.questionStatus).toBe('pending');
    expect(within(host).getByRole('region', { name: 'Question' })).toBeTruthy();
    expect(fixture.state.requiresAction).toBe(true);
    const send = vi.spyOn(fixture.controller, 'sendMessage');
    fireEvent.click(within(host).getByRole('button', { name: 'Submit answers' }));
    await waitFor(() => expect(native.requests).toHaveLength(cancelledTurn === 'later' ? 3 : 2));
    expect(native.requests.at(-1)!.input).toEqual([{ type: 'text', text: expect.stringContaining('"answer":"History"') }]);
    const answerRun = native.runs.at(-1)!;
    answerRun.events.push({ type: 'turn_started', accepted: true, scope: requestedScope(native, answerRun, 1) });
    await waitFor(() => expect(within(host).queryByRole('region', { name: 'Question' })).toBeNull());
    expect(tool.resolvedAnswers).toEqual({ '0': 'History' });
    answerRun.events.push({ type: 'turn_completed', reason: 'completed', scope: requestedScope(native, answerRun, 2) });
    answerRun.events.end();
    await send.mock.results[0].value;
  } finally {
    fixture.controller.dismissPendingApproval();
    await execution.coordinator.dispose();
  }
});

it.each(['authority', 'cancel-and-replace'] as const)('fences an expired answer through real execution preparation (%s)', async phase => {
  const host = document.body.createDiv();
  const composer = host.createDiv();
  const execution = createExecutionHarness({ onRequestedEvent: event => fixture.controller.handleExecutionEvent(event) });
  const fixture = (await createFixture({
    getTabProviderId: () => 'codex', getInputContainerEl: () => composer,
    getExecutionCoordinator: () => execution.coordinator,
  }));
  await execution.coordinator.bindConversation({ conversationId: 'conversation-1', providerId: 'codex' });
  const running = fixture.controller.sendMessage({ content: 'Start work' });
  const backend = execution.backends.get('codex')!;
  await waitFor(() => expect(backend.sessions[0]?.runs).toHaveLength(1));
  const native = backend.sessions[0];
  const run = native.runs[0];
  run.events.push({ type: 'turn_started', accepted: true, scope: requestedScope(native, run, 1) });
  const authority = deferred<void>();
  const entered = deferred<void>();
  execution.repository.assertConversationExecutionAuthority.mockImplementationOnce(() => { entered.resolve(); return authority.promise; });
  const tool: ToolCallInfo = { id: 'ask', name: 'AskUserQuestion', status: 'completed', input: {
    replyMode: 'user-message', questions: [{ id: '0', question: 'Which check?', options: [{ label: 'History' }] }],
  } };
  fixture.state.messages.at(-1)!.toolCalls = [tool];
  fixture.controller.updateAsyncQuestion(tool);
  const answer = vi.spyOn(fixture.controller, 'answerQuestion');
  const question = within(host).getByRole('region', { name: 'Question' });
  fireEvent.click(within(question).getByRole('button', { name: 'History' }));
  fireEvent.click(within(question).getByRole('button', { name: 'Submit answers' }));
  await entered.promise;
  const answered = (answer.mock.results[0].value as Promise<void>).catch(() => undefined);
  let replacement: Promise<void> | undefined;
  if (phase === 'cancel-and-replace') {
    fixture.controller.cancelStreaming();
    await running;
    replacement = fixture.controller.sendMessage({ content: 'New work' });
  } else {
    tool.questionStatus = 'expired';
    fixture.controller.updateAsyncQuestion(tool);
  }
  await waitFor(() => expect(native.runs).toHaveLength(phase === 'cancel-and-replace' ? 2 : 1));
  authority.resolve();
  await answered;
  expect(native.steerRequests).toHaveLength(0);
  expect(fixture.state.queuedMessage).toBeNull();
  expect(within(host).queryByRole('region', { name: 'Question' })).toBeNull();
  const lastRun = native.runs.at(-1)!;
  lastRun.events.push({ type: 'turn_completed', reason: 'completed', scope: requestedScope(native, lastRun, 2) });
  lastRun.events.end();
  await (replacement ?? running);
  await execution.coordinator.dispose();
});

it.each(['initialization', 'authority', 'cancelled-initialization', 'failed-initialization'] as const)('keeps idle answer preparation out of the composer (%s)', async phase => {
  const host = document.body.createDiv();
  const composer = host.createDiv();
  const execution = createExecutionHarness({ onRequestedEvent: event => fixture.controller.handleExecutionEvent(event) });
  const fixture = (await createFixture({
    getTabProviderId: () => 'codex', getInputContainerEl: () => composer,
    getExecutionCoordinator: () => execution.coordinator,
  }));
  await execution.coordinator.bindConversation({ conversationId: 'conversation-1', providerId: 'codex' });
  const running = fixture.controller.sendMessage({ content: 'Start work' });
  const backend = execution.backends.get('codex')!;
  await waitFor(() => expect(backend.sessions[0]?.runs).toHaveLength(1));
  const native = backend.sessions[0];
  const run = native.runs[0];
  const tool: ToolCallInfo = { id: 'ask', name: 'AskUserQuestion', status: 'completed', input: {
    replyMode: 'user-message', questions: [{ id: '0', question: 'Which check?', options: [{ label: 'History' }] }],
  } };
  fixture.state.messages.at(-1)!.toolCalls = [tool];
  fixture.controller.updateAsyncQuestion(tool);
  run.events.push({ type: 'turn_completed', reason: 'completed', scope: requestedScope(native, run, 1) });
  run.events.end();
  await running;
  fixture.input.value = 'Keep this draft';
  const authority = deferred<void>();
  const initialization = deferred<boolean>();
  const entered = deferred<void>();
  if (phase !== 'authority') {
    fixture.deps.ensureExecutionInitialized = () => { entered.resolve(); return initialization.promise; };
  } else {
    execution.repository.assertConversationExecutionAuthority.mockImplementationOnce(() => { entered.resolve(); return authority.promise; });
  }
  const execute = native.execute.bind(native);
  vi.spyOn(native, 'execute').mockImplementation(request => {
    execute(request);
    const next = native.runs.at(-1)!;
    next.events.push({ type: 'turn_completed', reason: 'completed', scope: requestedScope(native, next, 1) });
    next.events.end();
    return next;
  });
  const send = vi.spyOn(fixture.controller, 'sendMessage');
  fireEvent.click(within(host).getByRole('button', { name: 'History' }));
  fireEvent.click(within(host).getByRole('button', { name: 'Submit answers' }));
  await entered.promise;
  if (phase === 'cancelled-initialization') fixture.controller.cancelStreaming();
  else if (phase !== 'failed-initialization') {
    tool.questionStatus = 'expired';
    fixture.controller.updateAsyncQuestion(tool);
  }
  authority.resolve();
  initialization.resolve(phase !== 'failed-initialization');
  await send.mock.results[0].value;
  expect(native.requests).toHaveLength(1);
  expect(fixture.input.value).toBe('Keep this draft');
  expect(fixture.state.queuedMessage).toBeNull();
  expect(Boolean(within(host).queryByRole('region', { name: 'Question' }))).toBe(phase === 'failed-initialization');
  expect(tool.resolvedAnswers).toBeUndefined();
  fixture.controller.dismissPendingApproval();
  await execution.coordinator.dispose();
});

it('does not restart main chat when an answer outlives cancellation during handoff', async () => {
  const host = document.body.createDiv();
  const composer = host.createDiv();
  const fixture = (await createFixture({ getTabProviderId: () => 'codex', getInputContainerEl: () => composer }));
  const execution = fixture.holdNextResponse();
  const running = fixture.controller.sendMessage({ content: 'Start work' });
  await execution.started;
  const handoff = deferred<boolean>();
  fixture.nativeSteer.mockReturnValueOnce(handoff.promise);
  const tool: ToolCallInfo = { id: 'ask', name: 'AskUserQuestion', status: 'completed', input: {
    replyMode: 'user-message', questions: [{ id: '0', question: 'Which check?', options: [{ label: 'History' }] }],
  } };
  fixture.state.messages.at(-1)!.toolCalls = [tool];
  fixture.controller.updateAsyncQuestion(tool);
  const question = within(host).getByRole('region', { name: 'Question' });
  fireEvent.click(within(question).getByRole('button', { name: 'History' }));
  fireEvent.click(within(question).getByRole('button', { name: 'Submit answers' }));
  await fixture.native.waitForSteer();
  fixture.controller.cancelStreaming();
  await running;
  expect(fixture.state.cancelRequested).toBe(false);
  handoff.resolve(false);
  await waitFor(() => expect(within(host).queryByRole('region', { name: 'Question' })).toBeNull());
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(fixture.native.requests).toHaveLength(1);
  expect(fixture.state.queuedMessage).toBeNull();
  expect(tool.questionStatus).toBe('expired');
  cleanups.push(() => fixture.controller.dismissPendingApproval());
});

it.each([true, false])('settles an active-turn answer without consuming the draft (steer accepted: %s)', async accepted => {
  const host = document.body.createDiv();
  const composer = host.createDiv();
  const fixture = (await createFixture({ getTabProviderId: () => 'codex', getInputContainerEl: () => composer }));
  fixture.state.queueIndicatorEl = composer.createDiv();
  await fixture.holdResponse();
  fixture.nativeSteer.mockResolvedValueOnce(accepted);
  fixture.input.value = 'Keep this draft';
  await fixture.controller.sendMessage({ content: 'Unrelated follow-up' });
  const queued = fixture.state.queuedMessage;
  const tool: ToolCallInfo = { id: 'ask', name: 'AskUserQuestion', status: 'completed', input: {
    replyMode: 'user-message', questions: [{ id: '0', question: 'Which check?', options: [{ label: 'History' }] }],
  } };
  fixture.state.addMessage({ id: 'assistant', role: 'assistant', content: '', timestamp: testDate().getTime(), toolCalls: [tool] });
  cleanups.push(() => fixture.controller.dismissPendingApproval());
  fixture.controller.updateAsyncQuestion(tool);
  const question = within(host).getByRole('region', { name: 'Question' });
  fireEvent.click(within(question).getByRole('button', { name: 'History' }));
  expect(await axe(question)).toHaveNoViolations();
  fireEvent.click(within(question).getByRole('button', { name: 'Submit answers' }));
  await waitFor(() => expect(within(host).queryByRole('region', { name: 'Question' })).toBeNull());
  expect(fixture.native.steerRequests).toHaveLength(1);
  const request = fixture.native.steerRequests[0];
  const canonicalText = request.input.filter(part => part.type === 'text').map(part => part.text).join('');
  expect(JSON.parse(canonicalText.split('\n')[1])).toEqual([{
    questionItemId: '["request_user_input_async","ask",0]', question: 'Which check?', answer: 'History',
  }]);
  const replyState = accepted ? fixture.coordinator.getSteerSubmission(request.inputId!)?.rawDisplayText
    : fixture.state.queuedMessage?.content.slice('Unrelated follow-up'.length);
  expect(replyState).toBe('');
  expect(tool.resolvedAnswers).toEqual({ '0': 'History' });
  expect(fixture.state.queuedMessage?.content).toBe('Unrelated follow-up');
  expect(fixture.state.queuedMessage === queued).toBe(accepted);
  expect(fixture.state.queuedMessage?.turnRequest?.text).toBe(accepted
    ? 'Unrelated follow-up' : `Unrelated follow-up\n\n${canonicalText}`);
  expect(within(composer).getByText('Queued')).toBeDefined();
  expect(fixture.state.isStreaming).toBe(true);
  expect(fixture.native.runs[0].cancelCalls).toBe(0);
  expect(fixture.input.value).toBe('Keep this draft');
  expect(composer.classList.contains('claudian-hidden')).toBe(false);
});

async function createSurface() {
  const composerHost = document.body.createDiv();
  const composer = composerHost.createDiv();
  const fixture = await createFixture({ getTabProviderId: () => 'codex', getInputContainerEl: () => composer });
  const { state, controller: input } = fixture;
  const { renderer, streamController: stream } = fixture.deps;
  const messages = fixture.deps.getMessagesEl()!;
  document.body.prepend(messages);
  const draft = fixture.input;
  composer.append(draft);
  draft.value = 'Unsent draft';
  const response: ChatMessage = { id: 'response', role: 'assistant', timestamp: testDate().getTime(), content: '', contentBlocks: [] };
  state.addMessage(response);
  state.currentContentEl = renderer.addMessage(response).querySelector('.claudian-message-content');
  const ask = async (id = 'ask') => {
    await stream.handleStreamChunk({ type: 'tool_use', id, name: 'AskUserQuestion', input: {
      replyMode: 'user-message', questions: [{ id: '0', question: 'Which check?', options: [{ label: 'History' }] }],
    } }, response);
    await stream.handleStreamChunk({ type: 'tool_result', id, content: 'Question sent.' }, response);
  };
  cleanups.push(() => input.dismissPendingApproval());
  return { ...fixture, messages, composerHost, composer, draft, state, renderer, stream, input, response, ask };
}

it('renders the own question-text answer in the live review when the id entry is only inherited', async () => {
  const h = (await createSurface());
  await h.stream.handleStreamChunk({ type: 'tool_use', id: 'ask', name: 'AskUserQuestion', input: {
    replyMode: 'user-message',
    questions: [
      { id: 'toString', question: 'Color?', options: [{ label: 'Blue' }, { label: 'Red' }] },
      { id: '1', question: 'Which check?', options: [{ label: 'History' }] },
    ],
  } }, h.response);
  await h.stream.handleStreamChunk({ type: 'tool_result', id: 'ask', content: 'Question sent.' }, h.response);
  const tool = h.response.toolCalls![0];
  tool.questionStatus = 'pending';
  tool.resolvedAnswers = JSON.parse('{"Color?":"Blue","1":"History"}');
  h.renderer.updateQuestionTool(tool);

  const reviewTexts = Array.from(h.messages.querySelectorAll('.claudian-ask-review-a-text'), el => el.textContent);
  expect(reviewTexts).toEqual(['Blue', 'History']);
});

it('keeps a partial user-message batch on the visible prompt', async () => {
  const h = (await createSurface());
  await h.stream.handleStreamChunk({ type: 'tool_use', id: 'ask', name: 'AskUserQuestion', input: {
    replyMode: 'user-message',
    questions: [
      { id: 'toString', question: 'Color?', options: [{ label: 'Blue' }, { label: 'Red' }] },
      { id: '1', question: 'Which check?', options: [{ label: 'History' }] },
    ],
  } }, h.response);
  await h.stream.handleStreamChunk({ type: 'tool_result', id: 'ask', content: 'Question sent.' }, h.response);
  const tool = h.response.toolCalls![0];
  tool.questionStatus = 'pending';
  tool.resolvedAnswers = JSON.parse('{"1":"History"}');
  h.renderer.updateQuestionTool(tool);

  expect(within(h.messages).queryByText('Answer in the question panel below.')).not.toBeNull();
  expect(h.messages.querySelectorAll('.claudian-ask-review-a-text')).toHaveLength(0);
  expect(Array.from(h.messages.querySelectorAll('.claudian-ask-item-label'), el => el.textContent))
    .toEqual(expect.arrayContaining(['Blue', 'History']));
});

it('replaces the composer immediately and stays visible when the response history collapses', async () => {
  const h = (await createSurface());
  await h.ask();
  const question = within(h.composerHost).getByRole('region', { name: 'Question' });
  expect(within(h.messages).queryByRole('region', { name: 'Question' })).toBeNull();
  expect(h.composer.classList.contains('claudian-hidden')).toBe(true);
  expect(h.state.requiresAction).toBe(true);
  h.response.durationSeconds = 18;
  await h.stream.handleStreamChunk({ type: 'text', content: 'Please choose a check.' }, h.response);
  await h.stream.finalizeCurrentTextBlock(h.response);
  h.renderer.finalizeResponse(h.response, h.state.messages);
  expect(within(h.messages).getByRole('button', { name: 'Worked for 00:18' }).getAttribute('aria-expanded')).toBe('false');
  expect(question.closest('[hidden]')).toBeNull();
  const authority = h.holdNextAuthority();
  const delivery = vi.spyOn(h.input, 'answerQuestion');
  fireEvent.click(within(question).getByRole('button', { name: 'History' }));
  fireEvent.click(within(question).getByRole('button', { name: 'Submit answers' }));
  const delivered = delivery.mock.results[0].value as Promise<void>;
  await expect(Promise.race([authority.started, delivered])).resolves.toBeUndefined();
  expect(h.composer.classList.contains('claudian-hidden')).toBe(true);
  expect(h.native.requests).toHaveLength(0);
  expect(h.response.toolCalls![0].resolvedAnswers).toBeUndefined();
  authority.resolve();
  await expect(delivered).resolves.toBeUndefined();
  expect(h.native.requests).toHaveLength(1);
  const text = h.native.requests[0].input.filter(part => part.type === 'text').map(part => part.text).join('');
  expect(JSON.parse(text.split('\n')[1])).toEqual([{
    questionItemId: '["request_user_input_async","ask",0]', question: 'Which check?', answer: 'History',
  }]);
  expect(h.response.toolCalls![0].resolvedAnswers).toEqual({ '0': 'History' });
  expect(h.response.toolCalls![0].questionStatus).toBeUndefined();
  await waitFor(() => expect(within(h.composerHost).queryByRole('region', { name: 'Question' })).toBeNull());
  expect(h.composer.classList.contains('claudian-hidden')).toBe(false);
  await waitFor(() => expect(h.state.requiresAction).toBe(false));
  expect(h.draft.value).toBe('Unsent draft');
  fireEvent.click(within(h.messages).getByRole('button', { name: 'Worked for 00:18' }));
  fireEvent.click(within(h.messages).getByRole('button', { name: /AskUserQuestion/ }));
  expect(within(h.messages).getByText('History')).toBeDefined();
  expect(within(h.messages).queryByRole('button', { name: 'History' })).toBeNull();
});

it.each(['error', 'blocked'] as const)('expires a %s question and restores the composer without sending', async status => {
  const h = (await createSurface());
  await h.ask();
  await h.stream.handleStreamChunk({ type: 'tool_result', id: 'ask', content: 'Request expired.',
    ...(status === 'error' ? { isError: true } : { isBlocked: true }),
  }, h.response);
  expect(within(h.composerHost).queryByRole('region', { name: 'Question' })).toBeNull();
  expect(h.composer.classList.contains('claudian-hidden')).toBe(false);
  await waitFor(() => expect(h.state.requiresAction).toBe(false));
  expect(h.draft.value).toBe('Unsent draft');
  expect(h.native.requests).toHaveLength(0);
  expect(h.response.toolCalls![0].resolvedAnswers).toBeUndefined();
  h.renderer.renderMessages(h.state.messages, () => 'Welcome');
  expect(within(h.composerHost).queryByRole('region', { name: 'Question' })).toBeNull();
});

it('expires pending delivery on conversation teardown without affecting the next question', async () => {
  const h = (await createSurface());
  await h.ask();
  const authority = h.holdNextAuthority();
  const delivery = vi.spyOn(h.input, 'answerQuestion');
  const question = within(h.composerHost).getByRole('region', { name: 'Question' });
  fireEvent.click(within(question).getByRole('button', { name: 'History' }));
  fireEvent.click(within(question).getByRole('button', { name: 'Submit answers' }));
  const delivered = delivery.mock.results[0].value as Promise<void>;
  const settled = delivered.catch(() => undefined);
  await authority.started;
  const old = h.response.toolCalls![0];
  h.input.dismissPendingApproval();
  expect(h.composer.classList.contains('claudian-hidden')).toBe(false);
  const next = { ...old, questionStatus: undefined, status: 'running' as const };
  h.input.updateAsyncQuestion(next);
  authority.resolve();
  await settled;
  expect(h.native.requests).toHaveLength(0);
  expect(old.resolvedAnswers).toBeUndefined();
  expect(within(h.composerHost).getByRole('region', { name: 'Question' })).toBeDefined();
  expect(h.composer.classList.contains('claudian-hidden')).toBe(true);
  expect(h.state.requiresAction).toBe(true);
});
