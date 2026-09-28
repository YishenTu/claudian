/** @jest-environment jsdom */
import '@/providers';

import { testDate } from '@test/helpers/testClock';
import { fireEvent, waitFor, within } from '@testing-library/dom';

import type { ChatMessage } from '@/core/types';
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

function createSurface() {
  const messages = document.body.createDiv();
  const composerHost = document.body.createDiv();
  const composer = composerHost.createDiv();
  const draft = composer.createEl('textarea');
  draft.value = 'Unsent draft';
  const state = new ChatState();
  state.currentConversationId = 'conversation';
  const plugin = { app: {}, settings: { mediaFolder: '', showMessageTimestamps: false } } as any;
  const renderer = new MessageRenderer(plugin, { registerDomEvent: jest.fn(), register: jest.fn(), addChild: jest.fn() } as any, messages);
  const stream = new StreamController({ plugin, state, renderer,
    subagentManager: new SubagentManager(() => undefined), getMessagesEl: () => messages,
    updateQueueIndicator: () => undefined, onQuestionToolChanged: tool => input.updateAsyncQuestion(tool),
  });
  const input = new InputController({ state, renderer, streamController: stream,
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
  expect(h.delivery).toHaveBeenCalledWith(h.response.toolCalls![0], { '0': 'History' }, 'conversation');
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
