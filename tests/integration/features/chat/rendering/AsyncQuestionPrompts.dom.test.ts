/** @jest-environment jsdom */
import '@/providers';

import { createHarness as createExecutionHarness, requestedScope } from '@test/helpers/ChatExecutionHarness';
import { createFixture, deferred } from '@test/helpers/ChatInputHarness';
import { createTestTabSession } from '@test/helpers/ConversationPorts';
import { testDate } from '@test/helpers/testClock';
import { fireEvent, waitFor, within } from '@testing-library/dom';
import { axe } from 'jest-axe';
import { Component } from 'obsidian';

import type { ChatMessage, ToolCallInfo } from '@/core/types';
import { InputController, type InputControllerDeps } from '@/features/chat/controllers/InputController';
import { StreamController } from '@/features/chat/controllers/StreamController';
import { MessageRenderer } from '@/features/chat/rendering/MessageRenderer';
import { SubagentManager } from '@/features/chat/services/SubagentManager';
import { ChatState } from '@/features/chat/state/ChatState';

HTMLElement.prototype.empty = function () { this.replaceChildren(); };
HTMLElement.prototype.addClass = function (...classes) { this.classList.add(...classes); };
HTMLElement.prototype.removeClass = function (...classes) { this.classList.remove(...classes); };
HTMLElement.prototype.toggleClass = function (names, enabled) {
  for (const name of Array.isArray(names) ? names : [names]) this.classList.toggle(name, enabled);
};
HTMLElement.prototype.scrollIntoView = function () {};
HTMLElement.prototype.setText = function (text) { this.textContent = String(text); };

const cleanups: Array<() => void> = [];
afterEach(() => {
  cleanups.splice(0).forEach(cleanup => cleanup());
  document.body.replaceChildren();
});

it.each(['asking', 'later'] as const)('keeps an unanswered question usable after stopping the %s turn', async cancelledTurn => {
  const host = document.body.createDiv();
  const composer = host.createDiv();
  const execution = createExecutionHarness({ onRequestedEvent: event => fixture.controller.handleExecutionEvent(event) });
  const fixture = createFixture({
    getTabProviderId: () => 'codex', getInputContainerEl: () => composer,
    getExecutionCoordinator: () => execution.coordinator,
  });
  Object.assign(fixture.deps.renderer, { updateQuestionTool: jest.fn() });
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
    const send = jest.spyOn(fixture.controller, 'sendMessage');
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

it.each(['configuration', 'authority', 'cancel-and-replace'] as const)('fences an expired answer through real execution preparation (%s)', async phase => {
  const host = document.body.createDiv();
  const composer = host.createDiv();
  const execution = createExecutionHarness({ onRequestedEvent: event => fixture.controller.handleExecutionEvent(event) });
  const fixture = createFixture({
    getTabProviderId: () => 'codex', getInputContainerEl: () => composer,
    getExecutionCoordinator: () => execution.coordinator,
  });
  Object.assign(fixture.deps.renderer, { updateQuestionTool: jest.fn() });
  await execution.coordinator.bindConversation({ conversationId: 'conversation-1', providerId: 'codex' });
  const running = fixture.controller.sendMessage({ content: 'Start work' });
  const backend = execution.backends.get('codex')!;
  await waitFor(() => expect(backend.sessions[0]?.runs).toHaveLength(1));
  const native = backend.sessions[0];
  const run = native.runs[0];
  run.events.push({ type: 'turn_started', accepted: true, scope: requestedScope(native, run, 1) });
  const preparing = deferred<readonly string[]>();
  const authority = deferred<void>();
  const entered = jest.fn();
  if (phase === 'configuration') {
    Object.assign(fixture.plugin, { getMainAgentDynamicSystemPromptSections: () => { entered(); return preparing.promise; } });
  } else {
    execution.repository.assertConversationExecutionAuthority.mockImplementationOnce(() => { entered(); return authority.promise; });
  }
  const tool: ToolCallInfo = { id: 'ask', name: 'AskUserQuestion', status: 'completed', input: {
    replyMode: 'user-message', questions: [{ id: '0', question: 'Which check?', options: [{ label: 'History' }] }],
  } };
  fixture.state.messages.at(-1)!.toolCalls = [tool];
  fixture.controller.updateAsyncQuestion(tool);
  const answer = jest.spyOn(fixture.controller, 'answerQuestion');
  const question = within(host).getByRole('region', { name: 'Question' });
  fireEvent.click(within(question).getByRole('button', { name: 'History' }));
  fireEvent.click(within(question).getByRole('button', { name: 'Submit answers' }));
  await waitFor(() => expect(entered).toHaveBeenCalledTimes(1));
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
  preparing.resolve([]);
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

it.each(['configuration', 'authority', 'cancelled-configuration', 'failed-initialization'] as const)('keeps idle answer preparation out of the composer (%s)', async phase => {
  const host = document.body.createDiv();
  const composer = host.createDiv();
  const execution = createExecutionHarness({ onRequestedEvent: event => fixture.controller.handleExecutionEvent(event) });
  const fixture = createFixture({
    getTabProviderId: () => 'codex', getInputContainerEl: () => composer,
    getExecutionCoordinator: () => execution.coordinator,
  });
  Object.assign(fixture.deps.renderer, { updateQuestionTool: jest.fn() });
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
  const preparing = deferred<readonly string[]>();
  const authority = deferred<void>();
  const initialization = deferred<boolean>();
  const entered = jest.fn();
  if (phase === 'failed-initialization') {
    fixture.deps.ensureExecutionInitialized = () => { entered(); return initialization.promise; };
  } else if (phase === 'configuration' || phase === 'cancelled-configuration') {
    Object.assign(fixture.plugin, { getMainAgentDynamicSystemPromptSections: () => { entered(); return preparing.promise; } });
  } else {
    execution.repository.assertConversationExecutionAuthority.mockImplementationOnce(() => { entered(); return authority.promise; });
  }
  const execute = native.execute.bind(native);
  jest.spyOn(native, 'execute').mockImplementation(request => {
    execute(request);
    const next = native.runs.at(-1)!;
    next.events.push({ type: 'turn_completed', reason: 'completed', scope: requestedScope(native, next, 1) });
    next.events.end();
    return next;
  });
  const send = jest.spyOn(fixture.controller, 'sendMessage');
  fireEvent.click(within(host).getByRole('button', { name: 'History' }));
  fireEvent.click(within(host).getByRole('button', { name: 'Submit answers' }));
  await waitFor(() => expect(entered).toHaveBeenCalledTimes(1));
  if (phase === 'cancelled-configuration') fixture.controller.cancelStreaming();
  else if (phase !== 'failed-initialization') {
    tool.questionStatus = 'expired';
    fixture.controller.updateAsyncQuestion(tool);
  }
  preparing.resolve([]);
  authority.resolve();
  initialization.resolve(false);
  await send.mock.results[0].value;
  expect(native.requests).toHaveLength(1);
  expect(fixture.input.value).toBe('Keep this draft');
  expect(fixture.state.queuedMessage).toBeNull();
  expect(Boolean(within(host).queryByRole('region', { name: 'Question' }))).toBe(phase === 'failed-initialization');
  expect(tool.resolvedAnswers).toBeUndefined();
  fixture.controller.dismissPendingApproval();
  await execution.coordinator.dispose();
});

it.each(['preparation', 'handoff'] as const)('does not restart main chat when an answer outlives cancellation during %s', async phase => {
  const host = document.body.createDiv();
  const composer = host.createDiv();
  const fixture = createFixture({ getTabProviderId: () => 'codex', getInputContainerEl: () => composer });
  Object.assign(fixture.deps.renderer, { updateQuestionTool: jest.fn() });
  const execution = deferred<{ accepted: boolean; status: string }>();
  fixture.coordinator.execute.mockReturnValueOnce(execution.promise);
  const running = fixture.controller.sendMessage({ content: 'Start work' });
  await waitFor(() => expect(fixture.coordinator.execute).toHaveBeenCalledTimes(1));
  const preparing = deferred<string[]>();
  const handoff = deferred<boolean>();
  const prepare = jest.fn(() => preparing.promise);
  if (phase === 'preparation') Object.assign(fixture.plugin, { getMainAgentDynamicSystemPromptSections: prepare });
  else fixture.coordinator.steer.mockReturnValueOnce(handoff.promise);
  const tool: ToolCallInfo = { id: 'ask', name: 'AskUserQuestion', status: 'completed', input: {
    replyMode: 'user-message', questions: [{ id: '0', question: 'Which check?', options: [{ label: 'History' }] }],
  } };
  fixture.state.messages.at(-1)!.toolCalls = [tool];
  fixture.controller.updateAsyncQuestion(tool);
  const question = within(host).getByRole('region', { name: 'Question' });
  fireEvent.click(within(question).getByRole('button', { name: 'History' }));
  fireEvent.click(within(question).getByRole('button', { name: 'Submit answers' }));
  await waitFor(() => expect(phase === 'preparation' ? prepare : fixture.coordinator.steer).toHaveBeenCalledTimes(1));
  fixture.controller.cancelStreaming();
  execution.resolve({ accepted: true, status: 'interrupted' });
  await running;
  expect(fixture.state.cancelRequested).toBe(false);
  preparing.resolve([]);
  handoff.resolve(false);
  await waitFor(() => expect(within(host).queryByRole('region', { name: 'Question' })).toBeNull());
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(fixture.coordinator.execute).toHaveBeenCalledTimes(1);
  expect(fixture.state.queuedMessage).toBeNull();
  expect(tool.questionStatus).toBe('expired');
  cleanups.push(() => fixture.controller.dismissPendingApproval());
});

it.each([true, false])('settles an active-turn answer without consuming the draft (steer accepted: %s)', async accepted => {
  const host = document.body.createDiv();
  const composer = host.createDiv();
  const fixture = createFixture({ getTabProviderId: () => 'codex', getInputContainerEl: () => composer });
  Object.assign(fixture.deps.renderer, { updateQuestionTool: jest.fn() });
  fixture.state.queueIndicatorEl = composer.createDiv();
  fixture.holdResponse();
  fixture.coordinator.steer.mockResolvedValueOnce(accepted);
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
  expect(fixture.coordinator.steer).toHaveBeenCalledTimes(1);
  const submission = fixture.coordinator.steer.mock.calls[0][0];
  expect(JSON.parse(submission.canonicalText.split('\n')[1])).toEqual([{
    questionItemId: '["request_user_input_async","ask",0]', question: 'Which check?', answer: 'History',
  }]);
  expect(submission.rawDisplayText).toBe('');
  expect(tool.resolvedAnswers).toEqual({ '0': 'History' });
  expect(fixture.state.queuedMessage?.content).toBe('Unrelated follow-up');
  expect(fixture.state.queuedMessage === queued).toBe(accepted);
  expect(fixture.state.queuedMessage?.turnRequest?.text).toBe(accepted
    ? 'Unrelated follow-up' : `Unrelated follow-up\n\n${submission.canonicalText}`);
  expect(within(composer).getByText('Queued')).toBeDefined();
  expect(fixture.state.isStreaming).toBe(true);
  expect(fixture.coordinator.cancel).not.toHaveBeenCalled();
  expect(fixture.input.value).toBe('Keep this draft');
  expect(composer.classList.contains('claudian-hidden')).toBe(false);
});

function createSurface() {
  const messages = document.body.createDiv();
  const composerHost = document.body.createDiv();
  const composer = composerHost.createDiv();
  const draft = composer.createEl('textarea');
  draft.value = 'Unsent draft';
  const session = createTestTabSession();
  const state = new ChatState({}, undefined, session.turns);
  state.currentConversationId = 'conversation';
  const plugin = { app: {}, settings: { mediaFolder: '', showMessageTimestamps: false } } as any;
  const renderer = new MessageRenderer(plugin, new Component(), messages);
  const stream = new StreamController({ plugin, state, renderer,
    subagentManager: new SubagentManager(() => undefined), getMessagesEl: () => messages,
    updateQueueIndicator: () => undefined, onQuestionToolChanged: tool => input.updateAsyncQuestion(tool),
  });
  const input = new InputController({ state, renderer, streamController: stream, session,
    getInputContainerEl: () => composer,
  } as unknown as InputControllerDeps);
  const delivery = jest.spyOn(input, 'answerQuestion').mockResolvedValue(undefined);
  const response: ChatMessage = { id: 'response', role: 'assistant', timestamp: testDate().getTime(), content: '', contentBlocks: [] };
  state.addMessage(response);
  state.currentContentEl = renderer.addMessage(response).querySelector('.claudian-message-content');
  const ask = async (id = 'ask') => {
    await stream.handleStreamChunk({ type: 'tool_use', id, name: 'AskUserQuestion', input: {
      replyMode: 'user-message', questions: [{ id: '0', question: 'Which check?', options: [{ label: 'History' }] }],
    } }, response);
    await stream.handleStreamChunk({ type: 'tool_result', id, content: 'Question sent.' }, response);
  };
  cleanups.push(() => { input.dismissPendingApproval(); stream.dispose(); renderer.dispose(); });
  return { messages, composerHost, composer, draft, state, renderer, stream, input, delivery, response, ask };
}

it('replaces the composer immediately and stays visible when the response history collapses', async () => {
  const h = createSurface();
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
  let accepted!: () => void;
  h.delivery.mockReturnValue(new Promise(resolve => { accepted = resolve; }));
  fireEvent.click(within(question).getByRole('button', { name: 'History' }));
  fireEvent.click(within(question).getByRole('button', { name: 'Submit answers' }));
  expect(h.composer.classList.contains('claudian-hidden')).toBe(true);
  expect(h.delivery).toHaveBeenCalledWith(h.response.toolCalls![0], { '0': 'History' }, 'conversation', expect.any(AbortSignal));
  accepted();
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
  const h = createSurface();
  await h.ask();
  await h.stream.handleStreamChunk({ type: 'tool_result', id: 'ask', content: 'Request expired.',
    ...(status === 'error' ? { isError: true } : { isBlocked: true }),
  }, h.response);
  expect(within(h.composerHost).queryByRole('region', { name: 'Question' })).toBeNull();
  expect(h.composer.classList.contains('claudian-hidden')).toBe(false);
  await waitFor(() => expect(h.state.requiresAction).toBe(false));
  expect(h.draft.value).toBe('Unsent draft');
  expect(h.delivery).not.toHaveBeenCalled();
  h.renderer.renderMessages(h.state.messages, () => 'Welcome');
  expect(within(h.composerHost).queryByRole('region', { name: 'Question' })).toBeNull();
});

it('expires pending delivery on conversation teardown without affecting the next question', async () => {
  const h = createSurface();
  await h.ask();
  let accepted!: () => void;
  h.delivery.mockReturnValueOnce(new Promise(resolve => { accepted = resolve; }));
  const question = within(h.composerHost).getByRole('region', { name: 'Question' });
  fireEvent.click(within(question).getByRole('button', { name: 'History' }));
  fireEvent.click(within(question).getByRole('button', { name: 'Submit answers' }));
  const old = h.response.toolCalls![0];
  h.input.dismissPendingApproval();
  expect(h.composer.classList.contains('claudian-hidden')).toBe(false);
  const next = { ...old, questionStatus: undefined, status: 'running' as const };
  h.input.updateAsyncQuestion(next);
  accepted();
  await Promise.resolve();
  await Promise.resolve();
  expect(old.resolvedAnswers).toBeUndefined();
  expect(within(h.composerHost).getByRole('region', { name: 'Question' })).toBeDefined();
  expect(h.composer.classList.contains('claudian-hidden')).toBe(true);
  expect(h.state.requiresAction).toBe(true);
});
