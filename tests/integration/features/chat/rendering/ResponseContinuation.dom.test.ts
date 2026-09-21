/** @jest-environment jsdom */
import '@/providers';

import * as reviewFs from 'node:fs/promises';

import { within } from '@testing-library/dom';
import { axe } from 'jest-axe';
import { MarkdownRenderer } from 'obsidian';

import type { ChatMessage } from '@/core/types';
import { StreamController } from '@/features/chat/controllers/StreamController';
import { MessageRenderer } from '@/features/chat/rendering/MessageRenderer';
import { continueResponseAfterNotification } from '@/features/chat/rendering/ResponseContinuation';
import { SubagentManager } from '@/features/chat/services/SubagentManager';
import { ChatState } from '@/features/chat/state/ChatState';
import { loadSDKSessionMessages } from '@/providers/claude/history/ClaudeHistoryStore';

jest.mock('node:fs/promises');
HTMLElement.prototype.empty = function () { this.replaceChildren(); };
HTMLElement.prototype.addClass = function (...classes) { this.classList.add(...classes); };
HTMLElement.prototype.removeClass = function (...classes) { this.classList.remove(...classes); };

beforeEach(() => {
  document.body.replaceChildren();
  jest.mocked(MarkdownRenderer.render).mockImplementation(async (_app, markdown, el) => {
    (el as HTMLElement).createEl('p', { text: markdown });
  });
});

it.each([false, true])('matches live and JSONL notification order with a late tool result=%s', async lateResult => {
  const { renderSessionTaskNotification } = await import('@/features/chat/rendering/BackgroundTurnRenderer');
  const messagesEl = document.body.createDiv();
  const plugin = { app: {}, settings: { mediaFolder: '', showMessageTimestamps: false } } as any;
  const renderer = new MessageRenderer(plugin,
    { registerDomEvent: jest.fn(), register: jest.fn(), addChild: jest.fn() } as any, messagesEl);
  const state = new ChatState();
  const subagents = new SubagentManager(() => undefined);
  const stream = new StreamController({ plugin, state, renderer, subagentManager: subagents,
    getMessagesEl: () => messagesEl, updateQueueIndicator: () => undefined });
  let response: ChatMessage = { id: 'response', role: 'assistant', timestamp: 1, content: '', contentBlocks: [] };
  const order = () => {
    const notification = within(messagesEl).getByRole('button', { name: 'Task notification' });
    const answer = within(messagesEl).getByText('Requested answer.');
    return (notification.compareDocumentPosition(answer) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
  };
  try {
    state.addMessage(response);
    state.currentContentEl = renderer.addMessage(response).querySelector('.claudian-message-content');
    await stream.handleStreamChunk({ type: 'tool_use', id: 'read', name: 'Read', input: { file_path: 'note.md' } }, response);
    renderSessionTaskNotification({ state, renderer, isConnected: () => true, createMessageId: () => 'notification' }, 'Task finished.');
    const toolMessage = response;
    if (!lateResult) await stream.handleStreamChunk({ type: 'tool_result', id: 'read', content: 'The note.' }, response);
    response = await continueResponseAfterNotification({ state, renderer, stream, createMessageId: () => 'continuation' }, response, { type: 'text', content: 'Requested answer.' });
    await stream.handleStreamChunk({ type: 'text', content: 'Requested answer.' }, response);
    if (lateResult) await stream.handleStreamChunk({ type: 'tool_use', id: 'read', name: 'Read', input: { file_path: 'note.md' } }, response);
    if (lateResult) await stream.handleStreamChunk({ type: 'tool_output', id: 'read', content: 'Partial output' }, response);
    expect(toolMessage.toolCalls?.[0].result).toBe(lateResult ? 'Partial output' : 'The note.');
    if (lateResult) await stream.handleStreamChunk({ type: 'tool_result', id: 'read', content: 'The note.' }, response);
    expect(toolMessage.toolCalls).toEqual([expect.objectContaining({ id: 'read', status: 'completed', result: 'The note.' })]);
    await stream.finalizeCurrentTextBlock(response);
    expect(response.contentBlocks).toEqual([{ type: 'text', content: 'Requested answer.' }]);
    renderer.finalizeResponse(response, state.messages);
    const liveNotificationBeforeAnswer = order();
    expect((await axe(messagesEl)).violations).toEqual([]);
    const entries = [
      { type: 'user', uuid: 'u', timestamp: '2026-09-20T11:00:10Z', message: { content: 'Read a note' } },
      { type: 'assistant', uuid: 'tool', parentUuid: 'u', timestamp: '2026-09-20T11:00:11Z', message: { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'read', name: 'Read', input: { file_path: 'note.md' } }] } },
      { type: 'user', uuid: 'result', parentUuid: 'tool', timestamp: '2026-09-20T11:00:12Z', toolUseResult: { content: 'The note.' }, message: { content: [{ type: 'tool_result', tool_use_id: 'read', content: 'The note.' }] } },
      { type: 'attachment', uuid: 'notification', parentUuid: 'result', timestamp: '2026-09-20T11:00:13Z', attachment: { type: 'queued_command', commandMode: 'task-notification', prompt: '<task-notification><task-id>task</task-id><status>completed</status><summary>Task finished.</summary></task-notification>' } },
      { type: 'assistant', uuid: 'answer', parentUuid: 'notification', timestamp: '2026-09-20T11:00:15Z', message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Requested answer.' }] } },
    ];
    jest.mocked(reviewFs.readFile).mockResolvedValue(entries.map(entry => JSON.stringify(entry)).join('\n'));
    const replay = await loadSDKSessionMessages('/vault', 'session', undefined, '/session.jsonl');
    expect(replay.error).toBeUndefined();
    messagesEl.replaceChildren();
    replay.messages.forEach((message, index) => renderer.renderStoredMessage(message, replay.messages, index));
    await Promise.resolve();
    const replayNotificationBeforeAnswer = order();
    expect(replayNotificationBeforeAnswer).toBe(true);
    expect({ liveNotificationBeforeAnswer }).toEqual({ liveNotificationBeforeAnswer: replayNotificationBeforeAnswer });
  } finally {
    stream.dispose(); subagents.clear(); renderer.dispose();
  }
});

it.each(['child', 'result', 'snapshot'] as const)('keeps a pending Agent before a notification when resolved by %s', async resolution => {
  const { renderSessionTaskNotification } = await import('@/features/chat/rendering/BackgroundTurnRenderer');
  const messagesEl = document.body.createDiv();
  const plugin = { app: {}, settings: { mediaFolder: '', showMessageTimestamps: false } } as any;
  const renderer = new MessageRenderer(plugin,
    { registerDomEvent: jest.fn(), register: jest.fn(), addChild: jest.fn() } as any, messagesEl);
  const state = new ChatState();
  const subagents = new SubagentManager(() => undefined);
  const stream = new StreamController({ plugin, state, renderer, subagentManager: subagents,
    getMessagesEl: () => messagesEl, updateQueueIndicator: () => undefined });
  const original: ChatMessage = { id: 'original', role: 'assistant', timestamp: 1, content: '', contentBlocks: [] };
  try {
    state.addMessage(original);
    state.currentContentEl = renderer.addMessage(original).querySelector('.claudian-message-content');
    await stream.handleStreamChunk({ type: 'tool_use', id: 'agent', name: 'Agent', input: { description: 'Research' } }, original);
    renderSessionTaskNotification({ state, renderer, isConnected: () => true, createMessageId: () => 'notification' }, 'Task finished.');
    const text = { type: 'text' as const, content: 'Continuation.' };
    const continuation = await continueResponseAfterNotification({ state, renderer, stream, createMessageId: () => 'continuation' }, original, text);
    await stream.handleStreamChunk(text, continuation);
    if (resolution === 'child') {
      await stream.handleStreamChunk({ type: 'subagent_tool_use', subagentId: 'agent', id: 'child-read', name: 'Read', input: { file_path: 'note.md' } }, continuation);
    } else if (resolution === 'result') {
      await stream.handleStreamChunk({ type: 'tool_result', id: 'agent', content: 'Research answer.' }, continuation);
    } else {
      await stream.handleStreamChunk({ type: 'tool_use', id: 'agent', name: 'Agent', input: { description: 'Research', run_in_background: false } }, continuation);
    }
    await stream.finalizeCurrentTextBlock(continuation);
    expect(original.toolCalls).toEqual([expect.objectContaining({ id: 'agent', subagent: expect.objectContaining({ description: 'Research' }) })]);
    expect(continuation.toolCalls).toEqual([]);
    const card = within(messagesEl).getByRole('button', { name: /Subagent task: Research/ });
    const notification = within(messagesEl).getByRole('button', { name: 'Task notification' });
    expect(card.compareDocumentPosition(notification) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(continuation.contentBlocks).toEqual([{ type: 'text', content: 'Continuation.' }]);
  } finally {
    stream.dispose(); subagents.clear(); renderer.dispose();
  }
});

it('does not recreate a response after its conversation is cleared during finalization', async () => {
  const { renderSessionTaskNotification } = await import('@/features/chat/rendering/BackgroundTurnRenderer');
  const messagesEl = document.body.createDiv();
  const plugin = { app: {}, settings: { mediaFolder: '', showMessageTimestamps: false } } as any;
  const renderer = new MessageRenderer(plugin,
    { registerDomEvent: jest.fn(), register: jest.fn(), addChild: jest.fn() } as any, messagesEl);
  const state = new ChatState();
  const subagents = new SubagentManager(() => undefined);
  const stream = new StreamController({ plugin, state, renderer, subagentManager: subagents,
    getMessagesEl: () => messagesEl, updateQueueIndicator: () => undefined });
  const original: ChatMessage = { id: 'original', role: 'assistant', timestamp: 1, content: '', contentBlocks: [] };
  try {
    state.addMessage(original);
    state.currentContentEl = renderer.addMessage(original).querySelector('.claudian-message-content');
    await stream.handleStreamChunk({ type: 'text', content: 'Earlier text.' }, original);
    renderSessionTaskNotification({ state, renderer, isConnected: () => true, createMessageId: () => 'notification' }, 'Task finished.');
    const pending = continueResponseAfterNotification({ state, renderer, stream, createMessageId: () => 'continuation' }, original, { type: 'text', content: 'Later text.' });
    state.clearMessages();
    messagesEl.replaceChildren();
    await pending;
    expect(state.messages).toEqual([]);
    expect(messagesEl.childElementCount).toBe(0);
  } finally {
    stream.dispose(); subagents.clear(); renderer.dispose();
  }
});
