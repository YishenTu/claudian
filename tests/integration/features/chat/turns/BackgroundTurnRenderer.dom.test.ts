/** @jest-environment jsdom */
import '@/providers';

import { createFixture, deferred } from '@test/helpers/ChatInputHarness';
import { createTabSession } from '@test/helpers/ConversationPorts';
import { enqueueTabSessionEvent } from '@test/helpers/features/chat/SessionEventsHarness';
import { FakeSideBackend } from '@test/helpers/features/chat/SideChatSessionHarness';
import { useClaudeSessionFiles } from '@test/helpers/providers/claudeHistory';
import { testClock, testDate } from '@test/helpers/testClock';
import { fireEvent, waitFor, within } from '@testing-library/dom';
import { axe } from 'jest-axe';
import { Component, MarkdownRenderer } from 'obsidian';

import { ProviderExecutionLifecycleRegistry, type ProviderExecutionRequest } from '@/core/execution';
import type { ChatMessage, ImageAttachment } from '@/core/types';
import { ChatExecutionCoordinator } from '@/features/chat/execution/ChatExecutionCoordinator';
import { MessageRenderer } from '@/features/chat/rendering/MessageRenderer';
import { ChatState } from '@/features/chat/state/ChatState';
import { SubagentManager } from '@/features/chat/subagents/SubagentManager';
import { BackgroundResponses } from '@/features/chat/turns/BackgroundResponses';
import { renderSessionTaskNotification } from '@/features/chat/turns/BackgroundTurnRenderer';
import { ResponseStream } from '@/features/chat/turns/ResponseStream';
import { StreamController } from '@/features/chat/turns/StreamController';
import { TurnCoordinator } from '@/features/chat/turns/TurnCoordinator';
import { loadSDKSessionMessages } from '@/providers/claude/history/ClaudeHistoryStore';
import { parsePiSessionContent } from '@/providers/pi/history/PiHistoryStore';

jest.mock('node:fs/promises');
const writeSession = useClaudeSessionFiles();
HTMLElement.prototype.appendText = function (text) { this.append(document.createTextNode(text)); };
HTMLElement.prototype.empty = function () { this.replaceChildren(); };
HTMLElement.prototype.addClass = function (...classes) { this.classList.add(...classes); };
HTMLElement.prototype.removeClass = function (...classes) { this.classList.remove(...classes); };
beforeEach(() => {
  document.body.replaceChildren();
  jest.mocked(MarkdownRenderer.render).mockImplementation(async (_app, markdown, el) => {
    (el as HTMLElement).createEl('p', { text: markdown });
  });
});

it.each(['attached', 'detached', 'absent', 'late-text', 'late-thinking'] as const)(
  'retains ordered text and thinking blocks with %s transcript content', async presentation => {
    const clock = testClock();
    const now = jest.spyOn(Date, 'now').mockImplementation(() => clock().getTime());
    const messagesEl = document.body.createDiv();
    const plugin = { app: {}, settings: { mediaFolder: '', showMessageTimestamps: false } } as any;
    const renderer = new MessageRenderer(plugin, new Component(), messagesEl);
    const state = new ChatState();
    const subagents = new SubagentManager(() => undefined);
    const stream = new StreamController({ plugin, state, renderer, subagentManager: subagents,
      getMessagesEl: () => messagesEl, updateQueueIndicator: () => undefined });
    const message: ChatMessage = {
      id: 'response', role: 'assistant', timestamp: clock().getTime(), content: '', contentBlocks: [], toolCalls: [],
    };
    state.addMessage(message);
    const mountContent = () => {
      state.currentContentEl = renderer.addMessage(message).querySelector('.claudian-message-content');
    };
    if (presentation === 'attached' || presentation === 'detached') mountContent();
    if (presentation === 'detached') messagesEl.remove();
    try {
      await stream.handleStreamChunk({ type: 'text', content: 'Before ' }, message);
      if (presentation === 'late-text') mountContent();
      await stream.handleStreamChunk({ type: 'text', content: 'thinking.' }, message);
      await stream.handleStreamChunk({ type: 'thinking', content: 'Consider ' }, message);
      clock.advance({ seconds: 2 });
      if (presentation === 'late-thinking') mountContent();
      await stream.handleStreamChunk({ type: 'thinking', content: 'the result.' }, message);
      clock.advance({ seconds: 1 });
      await stream.handleStreamChunk({ type: 'text', content: 'After thinking.' }, message);
      await stream.handleStreamChunk({ type: 'tool_use', id: 'read', name: 'Read', input: { file_path: 'note.md' } }, message);
      await stream.handleStreamChunk({ type: 'tool_result', id: 'read', content: 'Note contents' }, message);
      await stream.handleStreamChunk({ type: 'notice', level: 'warning', content: 'Unavailable file' }, message);
      await stream.handleStreamChunk({ type: 'error', content: 'Unable to continue' }, message);
      await stream.handleStreamChunk({ type: 'done' }, message);
      await stream.finalizeCurrentThinkingBlock(message);
      await stream.finalizeCurrentTextBlock(message);

      expect(message.contentBlocks).toEqual([
        { type: 'text', content: 'Before thinking.' },
        { type: 'thinking', content: 'Consider the result.', durationSeconds: 3 },
        { type: 'text', content: 'After thinking.' },
        { type: 'tool_use', toolId: 'read' },
        { type: 'text', content: '\n\n⚠️ **Blocked:** Unavailable file\n\n❌ **Error:** Unable to continue' },
      ]);
      expect(message.toolCalls).toEqual([expect.objectContaining({ id: 'read', status: 'completed', result: 'Note contents' })]);
    } finally {
      stream.resetStreamingState();
      stream.dispose(); subagents.clear(); renderer.dispose(); now.mockRestore();
    }
  },
);

it.each([false, true])('replay places the second notification before automatic output (compaction: %s)', async (compaction) => {
  const entries = [
    { type: 'user', uuid: 'u', message: { content: 'Start tasks' } },
    { type: 'assistant', uuid: 'a', parentUuid: 'u', message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Requested answer' }] } },
    { type: 'user', uuid: 'n1', parentUuid: 'a', message: { content: '<task-notification><task-id>first</task-id><status>completed</status><summary>First task finished.</summary></task-notification>' } },
    { type: 'assistant', uuid: 'tool', parentUuid: 'n1', message: { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'read', name: 'Read', input: { file_path: 'task.output' } }] } },
    { type: 'user', uuid: 'result', parentUuid: 'tool', message: { content: [{ type: 'tool_result', tool_use_id: 'read', content: 'First task result' }] } },
    { type: 'attachment', uuid: 'n2', parentUuid: 'result', attachment: { type: 'queued_command', commandMode: 'task-notification', prompt: '<task-notification><task-id>second</task-id><status>completed</status><summary>Second task finished.</summary></task-notification>' } },
    ...(compaction ? [{ type: 'system', subtype: 'compact_boundary', uuid: 'compact', parentUuid: 'n2' }] : []),
    { type: 'assistant', uuid: 'final', parentUuid: compaction ? 'compact' : 'n2', message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'After notification.' }] } },
  ];
  const sessionPath = writeSession(entries.map((entry, index) => ({ timestamp: new Date(1000 + index * 1000).toISOString(), ...entry })));
  const replay = await loadSDKSessionMessages('/vault', 'session', undefined, sessionPath);
  expect(replay.error).toBeUndefined();
  const messagesEl = document.body.createDiv();
  const renderer = new MessageRenderer({ app: {}, settings: { mediaFolder: '', showMessageTimestamps: false } } as any, new Component(), messagesEl);
  try {
    replay.messages.forEach((message, index) => renderer.renderStoredMessage(message, replay.messages, index));
    await Promise.resolve();
    const second = within(messagesEl).getAllByRole('button', { name: 'Task notification' })[1];
    const answer = within(messagesEl).getByText('After notification.');
    expect(second.compareDocumentPosition(answer) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const output = [second, ...(compaction ? [within(messagesEl).getByText('Conversation compacted')] : []), answer];
    for (const [index, element] of output.slice(1).entries()) {
      expect(output[index].compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
  } finally { renderer.dispose(); }
});

it.each([
  [false, false], [true, false], [false, true], [true, true],
])('keeps background tools and notification order (compaction: %s, steering: %s)', async (compaction, steering) => {
  const { messagesEl, renderer, state, stream, coordinator, session, backend, dispose } = createBackgroundChat();
  try {
    await coordinator.bindConversation({ conversationId: 'conversation', providerId: 'claude' });
    await coordinator.prepare();
    const requested: ChatMessage = { id: 'requested', role: 'assistant', timestamp: 1, content: '', contentBlocks: [] };
    state.addMessage(requested);
    state.currentContentEl = renderer.addMessage(requested).querySelector('.claudian-message-content');
    await stream.handleStreamChunk({ type: 'text', content: 'Requested ' }, requested);
    const current = state.currentContentEl;
    const native = backend.latest;
    native.emitSessionEvent({ type: 'task_notification', content: 'First task finished.' });
    native.emitBackgroundEvent({ type: 'background_turn_started' });
    native.emitBackgroundEvent({ type: 'tool_started', toolCallId: 'read', toolScope: { kind: 'main' }, name: 'Read', input: { file_path: 'task.output' } });
    native.emitSessionEvent({ type: 'task_notification', content: 'Second task finished.' });
    if (steering) native.emitBackgroundEvent({ type: 'user_message_started', content: 'Change the plan', nativeUserMessageId: 'steered-user' });
    native.emitBackgroundEvent({ type: 'tool_completed', toolCallId: 'read', toolScope: { kind: 'main' }, content: 'First task result' });
    if (compaction) native.emitBackgroundEvent({ type: 'context_compacted' });
    native.emitBackgroundEvent({ type: 'text_delta', text: 'After notification.' });
    native.emitBackgroundEvent({ type: 'background_turn_completed', reason: 'completed', nativeAssistantId: 'final-checkpoint' });
    await session.awaitBackgroundWork();
    const notifications = within(messagesEl).getAllByRole('button', { name: 'Task notification' });
    const automaticWork = within(messagesEl).getByText('Read');
    expect(notifications[0].compareDocumentPosition(automaticWork) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(automaticWork.compareDocumentPosition(notifications[1]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const notification = notifications[1];
    const answer = within(messagesEl).getByText('After notification.');
    expect(notification.compareDocumentPosition(answer) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const output = [notification, ...(steering ? [within(messagesEl).getByText('Change the plan')] : []),
      ...(compaction ? [within(messagesEl).getByText('Conversation compacted')] : []), answer];
    for (const [index, element] of output.slice(1).entries()) {
      expect(output[index].compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
    expect(state.messages.at(-1)).toMatchObject({ content: 'After notification.', assistantMessageId: 'final-checkpoint', isAutomaticResponse: !steering });
    expect(state.messages.flatMap(message => message.toolCalls ?? [])).toMatchObject([{ id: 'read', result: 'First task result', status: 'completed' }]);
    expect(state.messages.filter(message => message.assistantMessageId === 'final-checkpoint')).toHaveLength(1);
    expect(state.currentContentEl).toBe(current);
    await stream.handleStreamChunk({ type: 'text', content: 'answer' }, requested);
    await stream.finalizeCurrentTextBlock(requested);
    expect(requested.content).toBe('Requested answer');
    expect((await axe(messagesEl)).violations).toEqual([]);
  } finally {
    await dispose();
  }
});

it.each([
  ['', 'steered reply'], ['', ''], ['automatic prefix', 'steered reply'], ['automatic prefix', ''],
])('preserves background output around accepted input (prefix: %s, reply: %s)', async (prefix, reply) => {
  const { messagesEl, renderer, state, coordinator, session, backend, dispose } = createBackgroundChat();
  try {
    await coordinator.bindConversation({ conversationId: 'conversation', providerId: 'claude' });
    await coordinator.prepare();
    const native = backend.latest;
    native.emitBackgroundEvent({ type: 'background_turn_started' });
    if (prefix) native.emitBackgroundEvent({ type: 'text_delta', text: prefix });
    native.emitBackgroundEvent({ type: 'user_message_started', content: 'steered message', nativeUserMessageId: 'steered-user' });
    await session.awaitBackgroundWork();
    expect(within(messagesEl).getByText('steered message').closest('[hidden]')).toBeNull();
    // A later submission must not move ahead of the already accepted steer and its reserved response.
    const later: ChatMessage = { id: 'later', role: 'user', content: 'later input', timestamp: testDate().getTime() };
    state.addMessage(later); renderer.addMessage(later);
    if (reply) native.emitBackgroundEvent({ type: 'text_delta', text: reply });
    native.emitBackgroundEvent({ type: 'background_turn_completed', reason: 'completed', nativeAssistantId: 'steered-checkpoint' });
    await session.awaitBackgroundWork();
    expect(state.messages.filter(message => message.role === 'user').map(message => message.content)).toEqual(['steered message', 'later input']);
    expect(state.messages.find(message => message.role === 'user')?.userMessageId).toBe('steered-user');
    expect(state.messages).toMatchObject([
      ...(prefix ? [{ role: 'assistant', content: prefix, isAutomaticResponse: true }] : []),
      { role: 'user', content: 'steered message' },
      ...(reply ? [{ role: 'assistant', content: reply, assistantMessageId: 'steered-checkpoint', isAutomaticResponse: false }] : []),
      { role: 'user', content: 'later input' },
    ]);
    expect(state.messages.filter(message => message.assistantMessageId === 'steered-checkpoint')).toHaveLength(reply ? 1 : 0);
    const elements = [...(prefix ? [prefix] : []), 'steered message', ...(reply ? [reply] : []), 'later input'].map(text => within(messagesEl).getByText(text));
    expect(elements.slice(1).map((element, index) => !!(elements[index].compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING)))
      .toEqual(elements.slice(1).map(() => true));
    expect((await axe(messagesEl)).violations).toEqual([]);
  } finally { await dispose(); }
});

it('does not continue a steered reply from a later turn notification', async () => {
  const { messagesEl, state, coordinator, session, backend, dispose } = createBackgroundChat();
  try {
    await coordinator.bindConversation({ conversationId: 'conversation', providerId: 'claude' });
    await coordinator.prepare();
    const native = backend.latest;
    native.emitBackgroundEvent({ type: 'background_turn_started' });
    native.emitBackgroundEvent({ type: 'text_delta', text: 'first automatic' });
    native.emitBackgroundEvent({ type: 'background_turn_started' }, 'background-2');
    native.emitSessionEvent({ type: 'task_notification', content: 'Second turn task finished.' });
    native.emitBackgroundEvent({ type: 'user_message_started', content: 'steered message', nativeUserMessageId: 'steered-user' });
    native.emitBackgroundEvent({ type: 'text_delta', text: 'steered reply' });
    native.emitBackgroundEvent({ type: 'background_turn_completed', reason: 'completed', nativeAssistantId: 'steered-checkpoint' });
    await session.awaitBackgroundWork();
    const notification = within(messagesEl).getByRole('button', { name: 'Task notification' });
    const reply = within(messagesEl).getByText('steered reply');
    expect(reply.compareDocumentPosition(notification) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const steered = state.messages.find(message => message.content === 'steered reply');
    expect(steered).toMatchObject({ isAutomaticResponse: false, assistantMessageId: 'steered-checkpoint' });
    expect(steered?.responseContinuationOf).toBeUndefined();
    expect((await axe(messagesEl)).violations).toEqual([]);
  } finally { await dispose(); }
});

it.each([
  ['pending', 'background'], ['uncertain', 'background'],
  ['pending', 'automatic'], ['uncertain', 'automatic'],
  ['pending', 'requested'], ['uncertain', 'requested'],
  ['uncertain', 'rejected'],
])('reconciles late image input through real chat owners (%s acknowledgement, %s turn)', async (acknowledgement, destination) => {
  const { messagesEl, state, coordinator, session, backend, input, setImages, dispose } = createBackgroundChat(true);
  try {
    await coordinator.bindConversation({ conversationId: 'conversation-1', providerId: 'claude' });
    await coordinator.prepare();
    const native = backend.latest;
    const admission = deferred<boolean>();
    const nativeSteer = jest.fn((_request: ProviderExecutionRequest) => Promise.resolve(true))
      .mockImplementationOnce(() => admission.promise);
    Object.assign(native, { steer: nativeSteer });
    input!.input.value = 'initial message';
    const first = input!.controller.sendMessage();
    await waitFor(() => expect(native.requests).toHaveLength(1));
    native.emitOutput({ type: 'user_message_started', content: 'initial message', nativeUserMessageId: 'initial-user' });
    native.emitText('initial answer');
    await waitFor(() => expect(within(messagesEl).getByText('initial answer')).toBeTruthy());
    const image: ImageAttachment = { id: 'image', name: 'pixel.png', mediaType: 'image/png', data: 'aW1hZ2U=', size: 5, source: 'paste' };
    const display = destination === 'automatic' && acknowledgement === 'uncertain' ? 'steer with image' : '';
    input!.input.value = display;
    setImages([image]);
    await input!.controller.sendMessage();
    const steering = input!.controller.queue.steerNow();
    await waitFor(() => expect(nativeSteer).toHaveBeenCalledTimes(1));
    if (acknowledgement === 'uncertain') {
      admission.reject(new Error('Acknowledgement lost'));
      await steering;
    }
    native.complete();
    await first;
    state.hasPendingConversationSave = false;
    const accept = jest.spyOn(coordinator, 'acceptSteerFromProviderEvent');
    let next: Promise<void> | undefined;
    const late = { type: 'user_message_started' as const, content: '', nativeUserMessageId: 'late-image-user',
      inputId: nativeSteer.mock.calls[0][0].inputId };
    expect(late.inputId).toEqual(expect.any(String));
    if (destination === 'requested') {
      input!.input.value = 'new message';
      next = input!.controller.sendMessage();
    } else if (destination === 'rejected') {
      jest.spyOn(native, 'execute').mockImplementationOnce(() => {
        native.emitBackgroundEvent({ type: 'background_turn_started' });
        native.emitBackgroundEvent(late);
        throw new Error('New request failed admission');
      });
      input!.input.value = 'new message';
      await input!.controller.sendMessage();
    }
    await waitFor(() => expect(native.requests).toHaveLength(destination === 'requested' ? 2 : 1));
    if (destination === 'requested') {
      native.emitOutput({ type: 'user_message_started', content: 'new message', nativeUserMessageId: 'new-user' });
      admission.resolve(true);
      await steering;
      input!.input.value = 'new steer';
      await input!.controller.sendMessage();
      await input!.controller.queue.steerNow();
    }
    expect(nativeSteer).toHaveBeenCalledTimes(destination === 'requested' ? 2 : 1);
    if (destination === 'requested') {
      native.emitOutput(late);
      native.emitOutput({ type: 'user_message_started', content: 'provider expanded new steer', nativeUserMessageId: 'new-steer-user',
        inputId: nativeSteer.mock.calls[1][0].inputId });
    } else if (destination !== 'rejected') {
      native.emitBackgroundEvent({ type: 'background_turn_started' });
      if (destination === 'automatic') {
        native.emitBackgroundEvent({ type: 'assistant_message_started' });
        native.emitBackgroundEvent({ type: 'text_delta', text: 'automatic work before steering' });
      }
      native.emitBackgroundEvent(late);
    }
    admission.resolve(true);
    await steering;
    if (destination === 'requested') {
      native.emitText('image answer');
      native.complete();
      await next;
    } else {
      native.emitBackgroundEvent({ type: 'text_delta', text: 'image answer' });
      native.emitBackgroundEvent({ type: 'background_turn_completed', reason: 'completed', nativeAssistantId: 'late-checkpoint' });
    }
    await session.awaitBackgroundWork();
    expect(state.messages.filter(message => message.role === 'user')).toMatchObject([
      { content: 'initial message', userMessageId: 'initial-user' },
      ...(destination === 'requested' ? [{ content: 'new message', userMessageId: 'new-user' }] : []),
      { content: display, images: [image], userMessageId: 'late-image-user' },
      ...(destination === 'requested' ? [{ content: 'new steer', userMessageId: 'new-steer-user' }] : []),
    ]);
    expect(accept).toHaveBeenCalledWith(expect.any(String), 'late-image-user');
    expect(within(messagesEl).getByRole('img', { name: 'pixel.png' })).toBeTruthy();
    expect(within(messagesEl).getByText('image answer')).toBeTruthy();
    const prefix = 'automatic work before steering';
    expect(state.messages.filter(message => message.content === prefix || message.content === 'image answer'
      || message.userMessageId === 'late-image-user')).toMatchObject([
      ...(destination === 'automatic' ? [{ role: 'assistant', content: prefix, isAutomaticResponse: true }] : []),
      { role: 'user', content: display, images: [image], userMessageId: 'late-image-user' },
      { role: 'assistant', content: 'image answer', ...(destination === 'requested' ? {} : { isAutomaticResponse: false, assistantMessageId: 'late-checkpoint' }) },
    ]);
    expect(state.messages.filter(message => message.assistantMessageId === 'late-checkpoint')).toHaveLength(destination === 'requested' ? 0 : 1);
    const elements = [...(destination === 'automatic' ? [within(messagesEl).getByText(prefix)] : []),
      within(messagesEl).getByRole('img', { name: 'pixel.png' }), ...(display ? [within(messagesEl).getByText(display)] : []),
      within(messagesEl).getByText('image answer')];
    for (const [index, element] of elements.slice(1).entries()) {
      expect(elements[index].compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
    expect((await axe(messagesEl)).violations).toEqual([]);
    expect(input!.input.value).toBe(destination === 'rejected' ? 'new message' : '');
    expect(input!.controller.queue.message).toBeNull();
    expect(state.hasPendingConversationSave).toBe(true);
    expect(native.requests).toHaveLength(destination === 'requested' ? 2 : 1);
    expect(nativeSteer).toHaveBeenCalledTimes(destination === 'requested' ? 2 : 1);
  } finally { await dispose(); }
});

function createBackgroundChat(withInput = false) {
  const messagesEl = document.body.createDiv();
  const plugin = { app: {}, settings: { mediaFolder: '', showMessageTimestamps: false } } as any;
  const renderer = new MessageRenderer(plugin,
    new Component(), messagesEl);
  const lifecycleRegistry = new ProviderExecutionLifecycleRegistry();
  const backend = new FakeSideBackend();
  let input: ReturnType<typeof createFixture> | undefined;
  const coordinator = new ChatExecutionCoordinator({
    lifecycleRegistry, resolveBackend: () => backend,
    persistence: { persistExecutionSnapshot: async () => true, registerExecutionBinding: () => undefined,
      releaseExecutionBinding: () => undefined, assertConversationExecutionAuthority: async () => undefined,
      recordConversationActivity: async () => undefined },
    interactionPort: {} as any, vaultWorkingDirectory: '/vault', createId: () => 'binding',
    resolveMissingProviderSession: async () => 'not_found',
    onRequestedEvent: event => input?.controller.handleExecutionEvent(event),
    onSessionEvent: (event, context) => enqueueTabSessionEvent(tab, plugin, event, context),
  });
  const tabSession = createTabSession({ id: 'tab', conversationId: 'conversation', draftModel: null,
    providerId: 'claude', lifecycleState: 'ready' } as any, coordinator);
  const session = tabSession.runtime;
  const state = new ChatState({}, undefined, session.turns);
  const subagents = new SubagentManager(() => undefined);
  const stream = new StreamController({ plugin, state, renderer, subagentManager: subagents,
    getMessagesEl: () => messagesEl, updateQueueIndicator: () => undefined });
  let images: ImageAttachment[] = [];
  const setImages = (next: ImageAttachment[]) => { images = next; };
  if (withInput) input = createFixture({
    state, session, renderer, streamController: stream,
    getMessagesEl: () => messagesEl, getExecutionCoordinator: () => coordinator,
    getImageContextManager: () => ({
      clearImages: () => setImages([]), getAttachedImages: () => images,
      hasImages: () => images.length > 0, setImages,
    }),
  });
  const tab = { state, renderer, session: tabSession, executionCoordinator: coordinator, lifecycleState: 'ready',
    ui: { promptSuggestion: { discard() {} } },
    dom: { contentEl: messagesEl }, services: { subagentManager: subagents },
    controllers: { inputController: input?.controller, streamController: stream, conversationController: { save: async () => undefined } } } as any;
  return { messagesEl, renderer, state, stream, coordinator, session, backend, input, setImages, dispose: async () => {
    await coordinator.dispose(); await lifecycleRegistry.dispose();
    stream.dispose(); subagents.clear(); renderer.dispose();
  } };
}

it('records requested and background segments around notifications with no presenter', async () => {
  const state = new ChatState();
  const plugin = { app: {}, settings: {} } as any;
  const manager = new SubagentManager(() => undefined);
  const renderer = null;
  const stream = new StreamController({ plugin, state, renderer, subagentManager: manager,
    getMessagesEl: () => null, updateQueueIndicator: () => undefined });
  let nextId = 0;
  const host = { state, renderer, stream, turns: new TurnCoordinator(), createMessageId: () => `message-${++nextId}` };
  const response = new ResponseStream(host);
  const background = new BackgroundResponses(host);
  const requestedScope = { kind: 'requested' as const, sessionInstanceId: 'native', executionId: 'request', turnId: 'requested', sequence: 1 };
  const backgroundScope = { kind: 'background' as const, sessionInstanceId: 'native', turnId: 'background', sequence: 1 };
  try {
    response.start();
    await response.handleEvent({ type: 'text_delta', text: 'Before.', scope: requestedScope });
    background.reserve('binding', 'background');
    await background.handle('binding', { type: 'text_delta', text: 'Background before.', scope: backgroundScope }, () => true);
    renderSessionTaskNotification(host, 'Task finished.', requestedScope, backgroundScope);
    await response.handleEvent({ type: 'text_delta', text: 'After.', scope: { ...requestedScope, sequence: 2 } });
    await background.handle('binding', { type: 'text_delta', text: 'Background after.', scope: { ...backgroundScope, sequence: 2 } }, () => true);
    await background.handle('binding', { type: 'background_turn_completed', reason: 'completed', scope: { ...backgroundScope, sequence: 3 } }, () => true);
    await response.finish(response.active!, { interrupted: false, failed: false });
    expect(state.messages.map(message => message.contentBlocks)).toEqual([
      [{ type: 'text', content: 'Before.' }],
      [{ type: 'text', content: 'Background before.' }],
      [{ type: 'task_notification', content: 'Task finished.' }],
      [{ type: 'text', content: 'Background after.' }],
      [{ type: 'text', content: 'After.' }],
    ]);
  } finally { stream.dispose(); manager.clear(); }
});

it('retains a successful edit diff when no tool card was created', async () => {
  const state = new ChatState();
  const plugin = { app: { vault: { adapter: {} } }, settings: {} } as any;
  const manager = new SubagentManager(() => undefined);
  const messagesEl = document.body.createDiv();
  const renderer = new MessageRenderer(plugin, new Component(), messagesEl);
  const stream = new StreamController({ plugin, state, renderer, subagentManager: manager,
    getMessagesEl: () => messagesEl, updateQueueIndicator: () => undefined });
  const message: ChatMessage = { id: 'edit-response', role: 'assistant', timestamp: testClock()().getTime(), content: '' };
  try {
    await stream.handleStreamChunk({ type: 'tool_use', id: 'edit', name: 'Edit', input: { file_path: '/outside/note.md', old_string: 'old', new_string: 'new' } }, message);
    await stream.handleStreamChunk({ type: 'tool_result', id: 'edit', content: 'Updated.', resultDetails: {
      diff: { filePath: '/outside/note.md', diffLines: [{ type: 'delete', text: 'old', oldLineNum: 1 }, { type: 'insert', text: 'new', newLineNum: 1 }], stats: { added: 1, removed: 1 } },
    } }, message);
    expect(message.toolCalls?.[0].diffData).toEqual({ filePath: '/outside/note.md',
      diffLines: [{ type: 'delete', text: 'old', oldLineNum: 1 }, { type: 'insert', text: 'new', newLineNum: 1 }], stats: { added: 1, removed: 1 } });
    expect(messagesEl.childElementCount).toBe(0);
  } finally { stream.dispose(); manager.clear(); renderer.dispose(); }
});

/** Text a reader sees in an element, skipping collapsed disclosure content. */
function visibleText(element: HTMLElement): string {
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  const parts: string[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!node.parentElement?.closest('[hidden]') && node.textContent?.trim()) parts.push(node.textContent.trim());
  }
  return parts.join(' ');
}

function visibleTranscript(root: HTMLElement): string {
  return Array.from(root.querySelectorAll<HTMLElement>('.claudian-message'), visibleText).filter(Boolean).join(' ');
}

it.each([true, false])('folds a stopped automatic reply under Interrupted after its notification, live and on reload (output: %s)', async output => {
  const messagesEl = document.body.createDiv();
  const plugin = { app: {}, settings: { mediaFolder: '', showMessageTimestamps: false } } as any;
  const renderer = new MessageRenderer(plugin, new Component(), messagesEl, undefined, jest.fn());
  const state = new ChatState();
  const manager = new SubagentManager(() => undefined);
  const stream = new StreamController({ plugin, state, renderer, subagentManager: manager,
    getMessagesEl: () => messagesEl, updateQueueIndicator: () => undefined });
  let nextId = 0;
  const host = { state, renderer, stream, createMessageId: () => `message-${++nextId}` };
  const background = new BackgroundResponses(host);
  const scope = { kind: 'background' as const, sessionInstanceId: 'native', turnId: 'automatic', sequence: 0 };
  const next = () => ({ ...scope, sequence: ++scope.sequence });
  const inspect = () => {
    const header = within(messagesEl).queryByRole('button', { name: 'Interrupted · What should Claudian do instead?' });
    const history = header && document.getElementById(header.getAttribute('aria-controls')!)!;
    const collapsed = visibleTranscript(messagesEl);
    const actions = within(messagesEl).queryAllByRole('button', { name: /^(Copy message|Fork conversation|Worked.*)$/ }).length;
    if (header) fireEvent.click(header);
    const result = {
      collapsed, actions,
      folded: history ? visibleText(history) : null,
      // The header carries the indicator; the body never repeats it.
      indicatorInBody: history ? history.querySelector('.claudian-interrupted') !== null : null,
    };
    if (header) fireEvent.click(header);
    return result;
  };
  try {
    renderSessionTaskNotification(host, 'Job finished.', undefined, next());
    background.reserve('binding', 'automatic');
    if (output) {
      await background.handle('binding', { type: 'tool_started', toolCallId: 'read', toolScope: { kind: 'main' }, name: 'Read', input: { file_path: 'job.log' }, scope: next() }, () => true);
      await background.handle('binding', { type: 'text_delta', text: 'Checking the job.', scope: next() }, () => true);
    }
    await background.handle('binding', { type: 'background_turn_completed', reason: 'interrupted', nativeAssistantId: 'native-reply', scope: next() }, () => true);
    await Promise.resolve();
    // Replays may describe a never-finished tool differently; the fold, its order and its header must match.
    const foldedBody = expect.stringMatching(/^Read job\.log\b.*Checking the job\.$/);
    const live = { collapsed: 'Task notification Interrupted · What should Claudian do instead?', actions: 0,
      indicatorInBody: output ? false : null, folded: output ? foldedBody : null };
    expect(inspect()).toEqual(live);
    expect((await axe(messagesEl)).violations).toEqual([]);

    renderer.renderMessages(state.messages, () => 'Welcome');
    await Promise.resolve();
    expect(inspect()).toEqual(live);

    // DeepSeek and Pi replay the notification and the stopped reply as one automatic message.
    renderer.renderMessages([{ id: 'replayed', role: 'assistant', isAutomaticResponse: true, isInterrupt: true,
      assistantMessageId: 'native-reply', content: output ? 'Checking the job.' : '', timestamp: testDate().getTime(),
      toolCalls: output ? [{ id: 'read', name: 'Read', input: { file_path: 'job.log' }, status: 'running' }] : [],
      contentBlocks: [{ type: 'task_notification', content: 'Job finished.' },
        ...(output ? [{ type: 'tool_use' as const, toolId: 'read' }, { type: 'text' as const, content: 'Checking the job.' }] : [])] }], () => 'Welcome');
    await Promise.resolve();
    expect(inspect()).toEqual(live);

    // Claude Code 2.1.303 records the Stop as `[Request interrupted by user]` after the automatic reply.
    const at = (seconds: number) => new Date(testDate().getTime() + seconds * 1_000).toISOString();
    const claude = await loadSDKSessionMessages('/vault', 'session', undefined, writeSession([
      { type: 'user', uuid: 'notification', timestamp: at(0), message: { content:
        '<task-notification>\n<task-id>job</task-id>\n<status>completed</status>\n<summary>Job finished.</summary>\n</task-notification>' } },
      ...(output ? [
        { type: 'assistant', uuid: 'tool', parentUuid: 'notification', timestamp: at(1), message: { stop_reason: 'tool_use',
          content: [{ type: 'tool_use', id: 'read', name: 'Read', input: { file_path: 'job.log' } }] } },
        { type: 'user', uuid: 'result', parentUuid: 'tool', timestamp: at(2), toolUseResult: { content: 'Log.' },
          message: { content: [{ type: 'tool_result', tool_use_id: 'read', content: 'Log.' }] } },
        { type: 'assistant', uuid: 'reply', parentUuid: 'result', timestamp: at(3), message: { content: [{ type: 'text', text: 'Checking the job.' }] } },
      ] : []),
      { type: 'user', uuid: 'interrupt', parentUuid: output ? 'reply' : 'notification', timestamp: at(4),
        message: { content: [{ type: 'text', text: '[Request interrupted by user]' }] } },
    ]));
    expect(claude.error).toBeUndefined();
    renderer.renderMessages(claude.messages, () => 'Welcome');
    await Promise.resolve();
    expect(inspect()).toEqual(live);
  } finally { stream.dispose(); manager.clear(); renderer.dispose(); }
});

function createBackgroundSession() {
  const messagesEl = document.body.createDiv();
  const plugin = { app: {}, settings: { mediaFolder: '', showMessageTimestamps: false } } as any;
  const renderer = new MessageRenderer(plugin, new Component(), messagesEl);
  const state = new ChatState();
  const manager = new SubagentManager(() => undefined);
  const stream = new StreamController({ plugin, state, renderer, subagentManager: manager,
    getMessagesEl: () => messagesEl, updateQueueIndicator: () => undefined });
  let nextId = 0;
  const host = { state, renderer, stream, createMessageId: () => `message-${++nextId}` };
  const background = new BackgroundResponses(host);
  const scope = { kind: 'background' as const, sessionInstanceId: 'native', turnId: 'automatic', sequence: 0 };
  const next = () => ({ ...scope, sequence: ++scope.sequence });
  const text = (value: string) => background.handle('binding', { type: 'text_delta', text: value, scope: next() }, () => true);
  const stop = () => background.handle('binding', { type: 'background_turn_completed', reason: 'interrupted', scope: next() }, () => true);
  return { messagesEl, renderer, state, host, background, next, text, stop,
    dispose: () => { stream.dispose(); manager.clear(); renderer.dispose(); } };
}

it('keeps a reply before a steer intact and ends the steered input in an indicator when stopped before new output', async () => {
  const session = createBackgroundSession();
  const { messagesEl, renderer, state, background } = session;
  const inspect = () => ({
    transcript: Array.from(messagesEl.querySelectorAll<HTMLElement>('.claudian-message'), visibleText).filter(Boolean),
    disclosures: within(messagesEl).queryAllByRole('button', { name: /^(Interrupted|Worked)/ }).length,
  });
  try {
    renderSessionTaskNotification(session.host, 'Job finished.', undefined, session.next());
    background.reserve('binding', 'automatic');
    await session.text('Background reply.');
    background.userMessage('binding', { type: 'user_message_started', content: 'Make it shorter', scope: session.next() });
    await session.stop();
    await Promise.resolve();
    const expected = { transcript: ['Task notification', 'Background reply.', 'Make it shorter',
      'Interrupted · What should Claudian do instead?'], disclosures: 0 };
    expect(inspect()).toEqual(expected);
    expect(state.messages.find(message => message.content === 'Background reply.')?.isInterrupt).toBeUndefined();
    renderer.renderMessages(state.messages, () => 'Welcome');
    await Promise.resolve();
    expect(inspect()).toEqual(expected);
  } finally { session.dispose(); }
});

// A bare marker belongs to the turn that stopped: an automatic turn with no visible trigger
// that stops before output ends in a plain indicator and leaves the completed answer before it alone.
it('keeps a completed answer intact when the automatic turn after it stops before output', async () => {
  const session = createBackgroundSession();
  const { messagesEl, renderer, state, background } = session;
  const inspect = () => ({
    transcript: Array.from(messagesEl.querySelectorAll<HTMLElement>('.claudian-message'), visibleText).filter(Boolean),
    interrupted: within(messagesEl).queryAllByRole('button', { name: /^Interrupted/ }).length,
  });
  try {
    const prompt: ChatMessage = { id: 'prompt', role: 'user', content: 'Do the work', timestamp: testDate().getTime() };
    const answer: ChatMessage = { id: 'answer', role: 'assistant', content: 'Completed answer.', timestamp: testDate().getTime(),
      completedAt: testDate().getTime(), contentBlocks: [{ type: 'text', content: 'Completed answer.' }] };
    state.addMessage(prompt);
    state.addMessage(answer);
    renderer.renderMessages(state.messages, () => 'Welcome');
    background.reserve('binding', 'automatic');
    await session.stop();
    await Promise.resolve();
    const expected = { transcript: ['Do the work', 'Completed answer.', 'Interrupted · What should Claudian do instead?'], interrupted: 0 };
    expect(inspect()).toEqual(expected);
    renderer.renderMessages(state.messages, () => 'Welcome');
    await Promise.resolve();
    expect(inspect()).toEqual(expected);
  } finally { session.dispose(); }
});

// The interrupted reply before a marker only shows the marker of its own turn.
it('keeps the indicator of an automatic turn stopped before output after an interrupted requested reply', async () => {
  const session = createBackgroundSession();
  const { messagesEl, renderer, state, background } = session;
  const indicators = () => within(messagesEl).getAllByText('Interrupted').length;
  try {
    const prompt: ChatMessage = { id: 'prompt', role: 'user', content: 'Do the work', timestamp: testDate().getTime() };
    state.addMessage(prompt);
    renderer.renderMessages(state.messages, () => 'Welcome');
    const requested = new ResponseStream({ ...session.host, turns: new TurnCoordinator() });
    requested.start();
    await requested.handleEvent({ type: 'text_delta', text: 'Requested partial.',
      scope: { kind: 'requested', sessionInstanceId: 'native', executionId: 'execution', turnId: 'requested', sequence: 1 } });
    await requested.finish(requested.active!, { interrupted: true, failed: false });
    background.reserve('binding', 'automatic');
    await session.stop();
    await Promise.resolve();
    expect(indicators()).toBe(2);
    renderer.renderMessages(state.messages, () => 'Welcome');
    await Promise.resolve();
    expect(indicators()).toBe(2);
  } finally { session.dispose(); }
});

// Blank thinking is no output: the stop ends the reply before it, as the shared layout reads it.
it.each([true, false])('folds a background turn stopped after blank thinking like rerender (earlier reply: %s)', async earlier => {
  const session = createBackgroundSession();
  const { messagesEl, renderer, state, background } = session;
  const inspect = () => ({ transcript: visibleTranscript(messagesEl),
    headers: within(messagesEl).queryAllByRole('button', { name: /^Interrupted/ }).length });
  try {
    background.reserve('binding', 'automatic');
    if (earlier) {
      await session.text('Earlier reply.');
      renderSessionTaskNotification(session.host, 'Job finished.', undefined, session.next());
    }
    await background.handle('binding', { type: 'thinking_delta', text: '   ', scope: session.next() }, () => true);
    await session.stop();
    await Promise.resolve();
    const expected = { transcript: 'Interrupted · What should Claudian do instead?', headers: earlier ? 1 : 0 };
    expect(inspect()).toEqual(expected);
    renderer.renderMessages(state.messages, () => 'Welcome');
    await Promise.resolve();
    expect(inspect()).toEqual(expected);
  } finally { session.dispose(); }
});

// Output-free segments on either side of a notification show nothing: a turn stopped without
// output keeps its notification visible and ends in a plain indicator.
it('keeps a notification visible when blank thinking surrounds it in a stopped background turn', async () => {
  const session = createBackgroundSession();
  const { messagesEl, renderer, state, background } = session;
  const blankThinking = () => background.handle('binding', { type: 'thinking_delta', text: '   ', scope: session.next() }, () => true);
  const inspect = () => ({ transcript: visibleTranscript(messagesEl),
    headers: within(messagesEl).queryAllByRole('button', { name: /^Interrupted/ }).length });
  try {
    background.reserve('binding', 'automatic');
    await blankThinking();
    renderSessionTaskNotification(session.host, 'Job finished.', undefined, session.next());
    await blankThinking();
    await session.stop();
    await Promise.resolve();
    const expected = { transcript: 'Task notification Interrupted · What should Claudian do instead?', headers: 0 };
    expect(inspect()).toEqual(expected);
    renderer.renderMessages(state.messages, () => 'Welcome');
    await Promise.resolve();
    expect(inspect()).toEqual(expected);
  } finally { session.dispose(); }
});

it('folds a stopped automatic turn across a later notification once, live and on Claude reload', async () => {
  const session = createBackgroundSession();
  const { messagesEl, renderer, state, background } = session;
  const inspect = () => {
    const header = within(messagesEl).getByRole('button', { name: 'Interrupted · What should Claudian do instead?' });
    const history = document.getElementById(header.getAttribute('aria-controls')!)!;
    const collapsed = Array.from(messagesEl.querySelectorAll<HTMLElement>('.claudian-message'), visibleText).filter(Boolean).join(' ');
    fireEvent.click(header);
    const body = visibleText(history);
    fireEvent.click(header);
    return { collapsed, body, headers: within(messagesEl).getAllByRole('button', { name: /^Interrupted/ }).length };
  };
  // Replays may describe the never-finished tool differently; the fold, its order and its header must match.
  const expected = { collapsed: 'Task notification Interrupted · What should Claudian do instead?',
    body: expect.stringMatching(/^First part\. Read job\.log\b.*Task notification Second part\.$/), headers: 1 };
  try {
    renderSessionTaskNotification(session.host, 'First job finished.', undefined, session.next());
    background.reserve('binding', 'automatic');
    await session.text('First part.');
    await background.handle('binding', { type: 'tool_started', toolCallId: 'read', toolScope: { kind: 'main' }, name: 'Read', input: { file_path: 'job.log' }, scope: session.next() }, () => true);
    renderSessionTaskNotification(session.host, 'Second job finished.', undefined, { ...session.next() });
    await session.text('Second part.');
    await session.stop();
    await Promise.resolve();
    expect(inspect()).toEqual(expected);
    expect((await axe(messagesEl)).violations).toEqual([]);
    renderer.renderMessages(state.messages, () => 'Welcome');
    await Promise.resolve();
    expect(inspect()).toEqual(expected);

    const notification = claudeNotification;
    // Claude delivers the second notification mid-turn, between the tool call and its result.
    const claude = await loadSDKSessionMessages('/vault', 'session', undefined, writeSession([
      { type: 'user', uuid: 'first', timestamp: at(0), message: { content: notification('First job finished.') } },
      { type: 'assistant', uuid: 'a1', parentUuid: 'first', timestamp: at(1), message: { stop_reason: 'tool_use',
        content: [{ type: 'text', text: 'First part.' }, { type: 'tool_use', id: 'read', name: 'Read', input: { file_path: 'job.log' } }] } },
      { type: 'user', uuid: 'second', parentUuid: 'a1', timestamp: at(2), message: { content: notification('Second job finished.') } },
      { type: 'user', uuid: 'result', parentUuid: 'second', timestamp: at(3), toolUseResult: { content: 'Log.' },
        message: { content: [{ type: 'tool_result', tool_use_id: 'read', content: 'Log.' }] } },
      { type: 'assistant', uuid: 'a2', parentUuid: 'result', timestamp: at(4), message: { content: [{ type: 'text', text: 'Second part.' }] } },
      { type: 'user', uuid: 'interrupt', parentUuid: 'a2', timestamp: at(5), message: { content: [{ type: 'text', text: '[Request interrupted by user]' }] } },
    ]));
    // DeepSeek merges notices consumed within one turn into its reply.
    const deepseek: ChatMessage = { id: 'replayed', role: 'assistant', isAutomaticResponse: true, isInterrupt: true,
      content: 'First part.Second part.', timestamp: testDate().getTime(),
      toolCalls: [{ id: 'read', name: 'Read', input: { file_path: 'job.log' }, status: 'running' }],
      contentBlocks: [{ type: 'task_notification', content: 'First job finished.' }, { type: 'text', content: 'First part.' },
        { type: 'tool_use', toolId: 'read' }, { type: 'task_notification', content: 'Second job finished.' },
        { type: 'text', content: 'Second part.' }] };
    // Pi starts a new automatic message for an extension notice and records the Stop as `aborted`.
    const pi = parsePiSessionContent([
      { type: 'custom_message', id: 'c1', customType: 'peeps-result', display: true, content: 'First job finished.' },
      { type: 'message', id: 'a1', parentId: 'c1', message: { role: 'assistant', stopReason: 'toolUse',
        content: [{ type: 'text', text: 'First part.' }, { type: 'toolCall', id: 'read', name: 'read', arguments: { path: 'job.log' } }] } },
      { type: 'custom_message', id: 'c2', parentId: 'a1', customType: 'peeps-result', display: true, content: 'Second job finished.' },
      { type: 'message', id: 'a2', parentId: 'c2', message: { role: 'assistant', stopReason: 'aborted', errorMessage: 'Operation aborted',
        content: [{ type: 'text', text: 'Second part.' }] } },
    ].map(entry => JSON.stringify(entry)).join('\n'));
    for (const replay of [claude.messages, [deepseek], pi]) {
      renderer.renderMessages(replay, () => 'Welcome');
      await Promise.resolve();
      expect(inspect()).toEqual(expected);
    }
  } finally { session.dispose(); }
});

const claudeNotification = (summary: string) =>
  `<task-notification>\n<task-id>${summary}</task-id>\n<status>completed</status>\n<summary>${summary}</summary>\n</task-notification>`;
const at = (seconds: number) => new Date(testDate().getTime() + seconds * 1_000).toISOString();

it('keeps per-notification boundaries of a completed automatic turn, live and on Claude reload', async () => {
  const session = createBackgroundSession();
  const { messagesEl, renderer, background } = session;
  const transcript = () => ({
    visible: Array.from(messagesEl.querySelectorAll<HTMLElement>('.claudian-message'), visibleText).filter(Boolean).join(' '),
    disclosures: within(messagesEl).queryAllByRole('button', { name: /^(Interrupted|Worked)/ }).length,
  });
  // Each reply stays beside the notification it followed, with its tool visible.
  const expected = { visible: expect.stringMatching(/^Task notification First part\. Read job\.log\b.*Task notification Final answer\.$/), disclosures: 0 };
  try {
    renderSessionTaskNotification(session.host, 'First job finished.', undefined, session.next());
    background.reserve('binding', 'automatic');
    await session.text('First part.');
    await background.handle('binding', { type: 'tool_started', toolCallId: 'read', toolScope: { kind: 'main' }, name: 'Read', input: { file_path: 'job.log' }, scope: session.next() }, () => true);
    renderSessionTaskNotification(session.host, 'Second job finished.', undefined, session.next());
    await background.handle('binding', { type: 'tool_completed', toolCallId: 'read', toolScope: { kind: 'main' }, content: 'Log.', scope: session.next() }, () => true);
    await session.text('Final answer.');
    await background.handle('binding', { type: 'background_turn_completed', reason: 'completed', scope: session.next() }, () => true);
    await Promise.resolve();
    expect(transcript()).toEqual(expected);

    const claude = await loadSDKSessionMessages('/vault', 'session', undefined, writeSession([
      { type: 'user', uuid: 'first', timestamp: at(0), message: { content: claudeNotification('First job finished.') } },
      { type: 'assistant', uuid: 'a1', parentUuid: 'first', timestamp: at(1), message: { stop_reason: 'tool_use',
        content: [{ type: 'text', text: 'First part.' }, { type: 'tool_use', id: 'read', name: 'Read', input: { file_path: 'job.log' } }] } },
      { type: 'user', uuid: 'second', parentUuid: 'a1', timestamp: at(2), message: { content: claudeNotification('Second job finished.') } },
      { type: 'user', uuid: 'result', parentUuid: 'second', timestamp: at(3), toolUseResult: { content: 'Log.' },
        message: { content: [{ type: 'tool_result', tool_use_id: 'read', content: 'Log.' }] } },
      { type: 'assistant', uuid: 'a2', parentUuid: 'result', timestamp: at(4), message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Final answer.' }] } },
    ]));
    renderer.renderMessages(claude.messages, () => 'Welcome');
    await Promise.resolve();
    expect(transcript()).toEqual(expected);
  } finally { session.dispose(); }
});

it.each([true, false])('folds a notification that trails the stopped reply into its turn, live and on Claude reload (output: %s)', async output => {
  const session = createBackgroundSession();
  const { messagesEl, renderer, state, background } = session;
  const INTERRUPTED = 'Interrupted · What should Claudian do instead?';
  const inspect = () => {
    const header = within(messagesEl).queryByRole('button', { name: INTERRUPTED });
    const visible = Array.from(messagesEl.querySelectorAll<HTMLElement>('.claudian-message'), visibleText).filter(Boolean).join(' ');
    if (!header) return { visible, body: null };
    const history = document.getElementById(header.getAttribute('aria-controls')!)!;
    fireEvent.click(header);
    const body = visibleText(history);
    fireEvent.click(header);
    return { visible, body };
  };
  // The trailing notification arrived during the stopped turn: with output it folds with it; without, the line follows it.
  const foldedBody = expect.stringMatching(/^First part\. Read job\.log\b.*Task notification$/);
  const expected = output
    ? { visible: `Task notification ${INTERRUPTED}`, body: foldedBody }
    : { visible: `Task notification Task notification ${INTERRUPTED}`, body: null };
  try {
    renderSessionTaskNotification(session.host, 'First job finished.', undefined, session.next());
    background.reserve('binding', 'automatic');
    if (output) {
      await session.text('First part.');
      await background.handle('binding', { type: 'tool_started', toolCallId: 'read', toolScope: { kind: 'main' }, name: 'Read', input: { file_path: 'job.log' }, scope: session.next() }, () => true);
    }
    renderSessionTaskNotification(session.host, 'Second job finished.', undefined, session.next());
    await session.stop();
    await Promise.resolve();
    expect(inspect()).toEqual(expected);
    renderer.renderMessages(state.messages, () => 'Welcome');
    await Promise.resolve();
    expect(inspect()).toEqual(expected);

    const claude = await loadSDKSessionMessages('/vault', 'session', undefined, writeSession([
      { type: 'user', uuid: 'first', timestamp: at(0), message: { content: claudeNotification('First job finished.') } },
      ...(output ? [{ type: 'assistant', uuid: 'a1', parentUuid: 'first', timestamp: at(1), message: { stop_reason: 'tool_use',
        content: [{ type: 'text', text: 'First part.' }, { type: 'tool_use', id: 'read', name: 'Read', input: { file_path: 'job.log' } }] } }] : []),
      { type: 'user', uuid: 'second', parentUuid: output ? 'a1' : 'first', timestamp: at(2), message: { content: claudeNotification('Second job finished.') } },
      { type: 'user', uuid: 'interrupt', parentUuid: 'second', timestamp: at(3), message: { content: [{ type: 'text', text: '[Request interrupted by user]' }] } },
    ]));
    renderer.renderMessages(claude.messages, () => 'Welcome');
    await Promise.resolve();
    expect(inspect()).toEqual(expected);
  } finally { session.dispose(); }
});

it.each([true, false])('folds a stopped automatic turn across compaction once, live and on Claude reload (output after compaction: %s)', async after => {
  const session = createBackgroundSession();
  const { messagesEl, renderer, state, background } = session;
  const INTERRUPTED = 'Interrupted · What should Claudian do instead?';
  const inspect = () => {
    const header = within(messagesEl).getByRole('button', { name: INTERRUPTED });
    const history = document.getElementById(header.getAttribute('aria-controls')!)!;
    const visible = Array.from(messagesEl.querySelectorAll<HTMLElement>('.claudian-message'), visibleText).filter(Boolean).join(' ');
    fireEvent.click(header);
    const body = visibleText(history);
    fireEvent.click(header);
    return { visible, body };
  };
  const foldedBody = expect.stringMatching(after
    ? /^Before compaction\. Read job\.log\b.*Conversation compacted After compaction\.$/
    : /^Before compaction\. Read job\.log\b.*Conversation compacted$/);
  const expected = { visible: `Task notification ${INTERRUPTED}`, body: foldedBody };
  try {
    renderSessionTaskNotification(session.host, 'Job finished.', undefined, session.next());
    background.reserve('binding', 'automatic');
    await session.text('Before compaction.');
    await background.handle('binding', { type: 'tool_started', toolCallId: 'read', toolScope: { kind: 'main' }, name: 'Read', input: { file_path: 'job.log' }, scope: session.next() }, () => true);
    await background.handle('binding', { type: 'context_compacted', scope: session.next() }, () => true);
    if (after) await session.text('After compaction.');
    await session.stop();
    await Promise.resolve();
    expect(inspect()).toEqual(expected);
    renderer.renderMessages(state.messages, () => 'Welcome');
    await Promise.resolve();
    expect(inspect()).toEqual(expected);

    const claude = await loadSDKSessionMessages('/vault', 'session', undefined, writeSession([
      { type: 'user', uuid: 'n', timestamp: at(0), message: { content: claudeNotification('Job finished.') } },
      { type: 'assistant', uuid: 'tool', parentUuid: 'n', timestamp: at(1), message: { stop_reason: 'tool_use',
        content: [{ type: 'text', text: 'Before compaction.' }, { type: 'tool_use', id: 'read', name: 'Read', input: { file_path: 'job.log' } }] } },
      { type: 'user', uuid: 'result', parentUuid: 'tool', timestamp: at(2), toolUseResult: { content: 'Log.' },
        message: { content: [{ type: 'tool_result', tool_use_id: 'read', content: 'Log.' }] } },
      { type: 'system', subtype: 'compact_boundary', uuid: 'compact', parentUuid: 'result', timestamp: at(3),
        content: 'Conversation compacted', compactMetadata: { trigger: 'auto' } },
      ...(after ? [{ type: 'assistant', uuid: 'after', parentUuid: 'compact', timestamp: at(4),
        message: { content: [{ type: 'text', text: 'After compaction.' }] } }] : []),
      { type: 'user', uuid: 'interrupt', parentUuid: after ? 'after' : 'compact', timestamp: at(5),
        message: { content: [{ type: 'text', text: '[Request interrupted by user]' }] } },
    ]));
    renderer.renderMessages(claude.messages, () => 'Welcome');
    await Promise.resolve();
    expect(inspect()).toEqual(expected);
  } finally { session.dispose(); }
});
