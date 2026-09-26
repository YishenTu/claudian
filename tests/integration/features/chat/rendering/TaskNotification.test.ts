/** @jest-environment jsdom */

import '@/providers';

import { FakeSideBackend } from '@test/helpers/features/chat/SideChatSessionHarness';
import { fireEvent, within } from '@testing-library/dom';
import { axe } from 'jest-axe';
import { MarkdownRenderer } from 'obsidian';

import type { ProviderBackgroundEventScope, ProviderBackgroundOutputEvent } from '@/core/execution';
import type { ChatMessage } from '@/core/types';
import {
  providerOutputEventToStreamChunk,
  StreamController,
} from '@/features/chat/controllers/StreamController';
import { MessageRenderer } from '@/features/chat/rendering/MessageRenderer';
import { SubagentManager } from '@/features/chat/services/SubagentManager';
import { ChatState } from '@/features/chat/state/ChatState';
import { ClaudeExecutionEventNormalizer } from '@/providers/claude/execution/ClaudeExecutionEventNormalizer';

HTMLElement.prototype.empty = function () { this.replaceChildren(); };
HTMLElement.prototype.addClass = function (...classes) { this.classList.add(...classes); };
HTMLElement.prototype.removeClass = function (...classes) { this.classList.remove(...classes); };

function backgroundScope(sequence: number): ProviderBackgroundEventScope {
  return { kind: 'background', sessionInstanceId: 'session', turnId: 'automatic', sequence };
}

beforeEach(() => {
  document.body.replaceChildren();
  jest.mocked(MarkdownRenderer.render).mockImplementation(async (_app, markdown, el) => {
    (el as HTMLElement).createEl('p', { text: markdown });
  });
});

it('renders a native completion and its follow-up through the real chat stream pipeline', async () => {
  const messagesEl = document.body.createDiv();
  const plugin = { app: {}, settings: { mediaFolder: '', showMessageTimestamps: false } } as any;
  const renderer = new MessageRenderer(plugin,
    { registerDomEvent: jest.fn(), register: jest.fn(), addChild: jest.fn() } as any, messagesEl);
  const state = new ChatState();
  const subagentManager = new SubagentManager(() => undefined);
  const stream = new StreamController({
    plugin, state, renderer, subagentManager,
    getMessagesEl: () => messagesEl, updateQueueIndicator: () => undefined,
  });
  const message: ChatMessage = {
    id: 'automatic', role: 'assistant', isAutomaticResponse: true, timestamp: 1, content: '', contentBlocks: [],
  };
  const element = renderer.addMessage(message);
  state.currentContentEl = element.querySelector<HTMLElement>('.claudian-message-content');
  const scope: ProviderBackgroundEventScope = {
    kind: 'background', sessionInstanceId: 'session', turnId: 'background', sequence: 1,
  };
  const normalizer = new ClaudeExecutionEventNormalizer();
  try {
    for (const native of [
      { type: 'system', subtype: 'task_notification', session_id: 'session', task_id: 'task',
        status: 'completed', summary: 'There are 22 Markdown files.', uuid: 'notification' },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'Agent complete: 22 files.' }] } },
    ]) {
      for (const event of normalizer.normalize(native as any, 'background')) {
        if (event.type !== 'output') continue;
        const chunk = providerOutputEventToStreamChunk({ ...event.event, scope } as ProviderBackgroundOutputEvent);
        if (chunk) await stream.handleStreamChunk(chunk, message);
      }
    }
    await stream.finalizeCurrentTextBlock(message);
    renderer.finalizeResponse(message, [message]);

    const header = within(messagesEl).getByRole('button', { name: 'Task notification' });
    const result = within(messagesEl).getByText('There are 22 Markdown files.');
    expect(result.closest('[hidden]')).not.toBeNull();
    expect(within(messagesEl).getByText('Agent complete: 22 files.').closest('[hidden]')).toBeNull();
    fireEvent.click(header);
    expect(result.closest('[hidden]')).toBeNull();
    expect(message.contentBlocks).toEqual([
      { type: 'task_notification', content: 'There are 22 Markdown files.' },
      { type: 'text', content: 'Agent complete: 22 files.' },
    ]);
    expect(within(messagesEl).queryByRole('button', { name: /^Worked/ })).toBeNull();
  } finally {
    stream.dispose();
    subagentManager.clear();
    renderer.dispose();
  }
});

it.each([false, true])('shows a session notification immediately with streaming=%s without disturbing the response', async (streaming) => {
  const { ProviderExecutionLifecycleRegistry } = await import('@/core/execution');
  const { ChatExecutionCoordinator } = await import('@/features/chat/execution/ChatExecutionCoordinator');
  const { TabSession } = await import('@/features/chat/tabs/TabSession');
  const { enqueueTabSessionEvent } = await import('@/features/chat/tabs/TabSessionEvents');
  const messagesEl = document.body.createDiv();
  const plugin = { app: {}, settings: { mediaFolder: '', showMessageTimestamps: false } } as any;
  const renderer = new MessageRenderer(plugin,
    { registerDomEvent: jest.fn(), register: jest.fn(), addChild: jest.fn() } as any, messagesEl);
  const state = new ChatState();
  const subagents = new SubagentManager(() => undefined);
  const stream = new StreamController({ plugin, state, renderer, subagentManager: subagents,
    getMessagesEl: () => messagesEl, updateQueueIndicator: () => undefined });
  const lifecycleRegistry = new ProviderExecutionLifecycleRegistry();
  const backend = new FakeSideBackend();
  const coordinator = new ChatExecutionCoordinator({
    lifecycleRegistry, resolveBackend: () => backend,
    persistence: { persistExecutionSnapshot: async () => true, registerExecutionBinding: () => undefined, releaseExecutionBinding: () => undefined } as any,
    interactionPort: {} as any, vaultWorkingDirectory: '/vault', createId: () => 'binding',
    resolveMissingProviderSession: async () => 'not_found',
    onSessionEvent: (event, context) => enqueueTabSessionEvent(tab, plugin, event, context),
  });
  const session = new TabSession({ id: 'tab', conversationId: 'conversation', draftModel: null,
    providerId: 'claude', lifecycleState: 'ready' } as any, coordinator);
  const tab = { state, renderer, session, executionCoordinator: coordinator, lifecycleState: 'ready',
    dom: { contentEl: messagesEl }, services: { subagentManager: subagents },
    controllers: { streamController: stream, conversationController: { save: async () => undefined } } } as any;
  try {
    await coordinator.bindConversation({ conversationId: 'conversation', providerId: 'claude' });
    await coordinator.prepare();
    const response: ChatMessage = { id: 'response', role: 'assistant', timestamp: 1, content: '', contentBlocks: [] };
    if (streaming) {
      state.addMessage(response);
      state.currentContentEl = renderer.addMessage(response).querySelector('.claudian-message-content');
      await stream.handleStreamChunk({ type: 'text', content: 'Still working. ' }, response);
    }
    const current = state.currentContentEl;
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    void session.enqueueBackgroundWork(() => blocked);
    backend.latest.emitBackgroundEvent({ type: 'background_turn_started' });
    backend.latest.emitBackgroundEvent({ type: 'text_delta', text: 'Earlier background response' });
    backend.latest.emitSessionEvent({ type: 'task_notification', content: 'Task finished independently.' });
    let header: HTMLElement;
    try {
      header = await within(messagesEl).findByRole('button', { name: 'Task notification' });
    } finally {
      release();
      await session.awaitBackgroundWork();
    }
    expect(state.currentContentEl).toBe(current);
    backend.latest.emitBackgroundEvent({ type: 'background_turn_completed', reason: 'completed' });
    await session.awaitBackgroundWork();
    expect(state.messages.findIndex(message => message.content === 'Earlier background response')).toBeLessThan(
      state.messages.findIndex(message => message.contentBlocks?.some(block => block.type === 'task_notification')),
    );
    fireEvent.click(header);
    expect(within(messagesEl).getByText('Task finished independently.').closest('[hidden]')).toBeNull();
    if (streaming) {
      await stream.handleStreamChunk({ type: 'text', content: 'Answer finished.' }, response);
      await stream.finalizeCurrentTextBlock(response);
    }
    expect(response.content).toBe(streaming ? 'Still working. Answer finished.' : '');
    expect((await axe(messagesEl)).violations).toEqual([]);
    expect(within(messagesEl).getAllByRole('button', { name: 'Task notification' })).toHaveLength(1);
  } finally {
    await coordinator.dispose();
    await lifecycleRegistry.dispose();
    stream.dispose(); subagents.clear(); renderer.dispose();
  }
});

it.each(['text', 'image', 'image-only'])('keeps preceding output before a %s prompt and isolates concurrent rendering', async kind => {
  const { renderAutoTriggeredTurn, reserveBackgroundTurn } = await import('@/features/chat/rendering/BackgroundTurnRenderer');
  const messagesEl = document.body.createDiv();
  const plugin = { app: {}, settings: { mediaFolder: '', showMessageTimestamps: false } } as any;
  const renderer = new MessageRenderer(plugin,
    { registerDomEvent: jest.fn(), register: jest.fn(), addChild: jest.fn() } as any, messagesEl);
  const state = new ChatState();
  const subagents = new SubagentManager(() => undefined);
  const stream = new StreamController({ plugin, state, renderer, subagentManager: subagents,
    getMessagesEl: () => messagesEl, updateQueueIndicator: () => undefined });
  const target = reserveBackgroundTurn({ state, renderer, createMessageId: () => 'automatic' });
  const user: ChatMessage = { id: 'followup', role: 'user', timestamp: 2,
    content: kind === 'image-only' ? '' : 'Follow up',
    images: kind === 'text' ? undefined : [{ id: 'image', name: 'example.png', mediaType: 'image/png', data: 'aW1hZ2U=', size: 5, source: 'file' } as any],
  };
  const response: ChatMessage = { id: 'response', role: 'assistant', timestamp: 3, content: '', contentBlocks: [] };
  state.addMessage(user); renderer.addMessage(user);
  state.addMessage(response);
  state.currentContentEl = renderer.addMessage(response).querySelector('.claudian-message-content');
  await stream.handleStreamChunk({ type: 'text', content: 'Requested ' }, response);
  let rendering!: () => void;
  let release!: () => void;
  const entered = new Promise<void>(resolve => { rendering = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  jest.mocked(MarkdownRenderer.render).mockImplementation(async (_app, markdown, el) => {
    if (markdown === 'Earlier automatic output') { rendering(); await gate; }
    (el as HTMLElement).textContent = markdown;
  });
  const pending = renderAutoTriggeredTurn({ state, renderer, stream,
    isConnected: () => true, createMessageId: () => 'automatic' }, {
    events: [{ type: 'text_delta', text: 'Earlier automatic output', scope: backgroundScope(1) }], metadata: {}, target,
  }, () => true);
  try {
    await entered;
    await stream.handleStreamChunk({ type: 'text', content: 'answer' }, response);
    release();
    await pending;
    await stream.finalizeCurrentTextBlock(response);
    expect(response.content).toBe('Requested answer');
    expect(within(messagesEl).getByText('Requested answer')).toBeDefined();
    expect(state.messages.map(message => message.id)).toEqual(['automatic', 'followup', 'response']);
    const earlier = within(messagesEl).getByText('Earlier automatic output');
    const prompt = kind === 'text' ? within(messagesEl).getByText('Follow up') : within(messagesEl).getByRole('img');
    expect(earlier.compareDocumentPosition(prompt) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  } finally {
    release(); await pending;
    stream.dispose(); subagents.clear(); renderer.dispose();
  }
});


it.each([false, true])('flushes an automatic tool card before stream disposal with result=%s', async completed => {
  const { renderAutoTriggeredTurn } = await import('@/features/chat/rendering/BackgroundTurnRenderer');
  const messagesEl = document.body.createDiv();
  const plugin = { app: {}, settings: { mediaFolder: '', showMessageTimestamps: false } } as any;
  const renderer = new MessageRenderer(plugin,
    { registerDomEvent: jest.fn(), register: jest.fn(), addChild: jest.fn() } as any, messagesEl);
  const state = new ChatState();
  const subagents = new SubagentManager(() => undefined);
  const stream = new StreamController({ plugin, state, renderer, subagentManager: subagents,
    getMessagesEl: () => messagesEl, updateQueueIndicator: () => undefined });
  try {
    await renderAutoTriggeredTurn({ state, renderer, stream, isConnected: () => true, createMessageId: () => 'automatic' }, {
      events: [
        { type: 'tool_started', toolCallId: 'read', toolScope: { kind: 'main' }, name: 'Read', input: { file_path: '/tmp/output.txt' }, scope: backgroundScope(1) },
        ...(completed ? [{ type: 'tool_completed' as const, toolCallId: 'read', toolScope: { kind: 'main' as const }, content: 'Task output', scope: backgroundScope(2) }] : []),
      ], metadata: {},
    }, () => true);
    const worked = within(messagesEl).queryByRole('button', { name: /^Worked/ });
    if (worked) fireEvent.click(worked);
    const card = within(messagesEl).getByRole('button', { name: /Read.*output.txt/ });
    fireEvent.click(card);
    expect(within(messagesEl).queryByText('Task output') !== null).toBe(completed);
    expect((await axe(messagesEl)).violations).toEqual([]);
  } finally {
    stream.dispose(); subagents.clear(); renderer.dispose();
  }
});

it.each([false, true])('keeps automatic Agent results across requested settlement with pending=%s', async pendingAgent => {
  const { renderAutoTriggeredTurn } = await import('@/features/chat/rendering/BackgroundTurnRenderer');
  const messagesEl = document.body.createDiv();
  const plugin = { app: {}, settings: { mediaFolder: '', showMessageTimestamps: false } } as any;
  const renderer = new MessageRenderer(plugin,
    { registerDomEvent: jest.fn(), register: jest.fn(), addChild: jest.fn() } as any, messagesEl);
  const state = new ChatState();
  const subagents = new SubagentManager(() => undefined);
  const stream = new StreamController({ plugin, state, renderer, subagentManager: subagents,
    getMessagesEl: () => messagesEl, updateQueueIndicator: () => undefined });
  let entered!: () => void;
  let release!: () => void;
  const rendering = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  jest.mocked(MarkdownRenderer.render).mockImplementation(async (_app, markdown, el) => {
    if (markdown === 'Automatic continuation') { entered(); await gate; }
    (el as HTMLElement).textContent = markdown;
  });
  const pending = renderAutoTriggeredTurn({ state, renderer, stream, isConnected: () => true, createMessageId: () => 'automatic' }, {
    events: [
      { type: 'tool_started', toolCallId: 'agent', toolScope: { kind: 'main' }, name: 'Agent', input: { ...(pendingAgent ? {} : { run_in_background: false }), description: 'Automatic helper', prompt: 'Inspect output' }, scope: backgroundScope(1) },
      { type: 'text_delta', text: 'Automatic continuation', scope: backgroundScope(2) },
      { type: 'tool_started', toolCallId: 'main-read', toolScope: { kind: 'main' }, name: 'Read', input: { file_path: '/tmp/main.txt' }, scope: backgroundScope(3) },
      { type: 'tool_started', toolCallId: 'child', toolScope: { kind: 'subagent', subagentId: 'agent' }, name: 'Read', input: { file_path: '/tmp/output.txt' }, scope: backgroundScope(4) },
      { type: 'tool_completed', toolCallId: 'child', toolScope: { kind: 'subagent', subagentId: 'agent' }, content: 'Child output', scope: backgroundScope(5) },
      { type: 'tool_completed', toolCallId: 'agent', toolScope: { kind: 'main' }, content: 'Helper done', scope: backgroundScope(6) },
    ], metadata: {},
  }, () => true);
  try {
    await rendering;
    stream.resetSubagentStreamingState();
    release();
    await pending;
    const worked = within(messagesEl).queryByRole('button', { name: /^Worked/ });
    if (worked) fireEvent.click(worked);
    fireEvent.click(within(messagesEl).getByRole('button', { name: /Automatic helper/ }));
    const tool = within(messagesEl).getByRole('button', { name: /Read.*output.txt/ });
    fireEvent.click(tool);
    expect(within(messagesEl).getByText('Child output')).toBeDefined();
    expect(state.messages[0].toolCalls?.find(tool => tool.id === 'agent')?.subagent).toEqual(expect.objectContaining({
      status: 'completed', result: 'Helper done',
      toolCalls: [expect.objectContaining({ id: 'child', status: 'completed', result: 'Child output' })],
    }));
    expect((await axe(messagesEl)).violations).toEqual([]);
  } finally {
    release(); await pending;
    stream.dispose(); subagents.clear(); renderer.dispose();
  }
});

it.each([false, true])('matches task-notification grouping before and after replay with intervening input=%s', async interveningInput => {
  const { renderAutoTriggeredTurn, renderSessionTaskNotification } = await import('@/features/chat/rendering/BackgroundTurnRenderer');
  const messagesEl = document.body.createDiv();
  const plugin = { app: {}, settings: { mediaFolder: '', showMessageTimestamps: false } } as any;
  const renderer = new MessageRenderer(plugin,
    { registerDomEvent: jest.fn(), register: jest.fn(), addChild: jest.fn() } as any, messagesEl);
  const state = new ChatState();
  const subagents = new SubagentManager(() => undefined);
  const stream = new StreamController({ plugin, state, renderer, subagentManager: subagents,
    getMessagesEl: () => messagesEl, updateQueueIndicator: () => undefined });
  let id = 0;
  const host = { state, renderer, stream, isConnected: () => true, createMessageId: () => `message-${++id}` };
  try {
    renderSessionTaskNotification(host, 'Background bash completed.');
    if (interveningInput) {
      const input: ChatMessage = { id: 'user-followup', role: 'user', content: 'Another request', timestamp: 1 };
      state.addMessage(input);
      renderer.addMessage(input);
    }
    await renderAutoTriggeredTurn(host, { events: [
      { type: 'tool_started', toolCallId: 'read-output', toolScope: { kind: 'main' }, name: 'Read', input: { file_path: '/tmp/output.txt' }, scope: backgroundScope(1) },
      { type: 'tool_completed', toolCallId: 'read-output', toolScope: { kind: 'main' }, content: '541 lines', scope: backgroundScope(2) },
      { type: 'text_delta', text: 'Bash complete: 541 lines.', scope: backgroundScope(3) },
    ], metadata: {} }, () => true);

    for (const replay of [false, true]) {
      if (replay) {
        messagesEl.replaceChildren();
        state.messages.forEach((message, index) => renderer.renderStoredMessage(message, state.messages, index));
        await Promise.resolve();
      }
      expect(within(messagesEl).queryByRole('button', { name: 'Worked' }) !== null).toBe(interveningInput);
      const answer = within(messagesEl).getByText('Bash complete: 541 lines.');
      expect(answer.closest('[hidden]')).toBeNull();
      const notification = within(messagesEl).getByRole('button', { name: 'Task notification' });
      fireEvent.click(notification);
      expect(within(messagesEl).getByText('Background bash completed.').closest('[hidden]')).toBeNull();
      expect(within(messagesEl).queryByRole('button', { name: /Read.*output.txt/ }) !== null).toBe(!interveningInput);
      expect((await axe(messagesEl)).violations).toEqual([]);
    }
  } finally {
    stream.dispose(); subagents.clear(); renderer.dispose();
  }
});
