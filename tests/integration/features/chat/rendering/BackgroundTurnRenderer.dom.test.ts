/** @jest-environment jsdom */
import '@/providers';

import * as fs from 'node:fs/promises';

import { FakeSideBackend } from '@test/helpers/features/chat/SideChatSessionHarness';
import { within } from '@testing-library/dom';
import { axe } from 'jest-axe';
import { MarkdownRenderer } from 'obsidian';

import { ProviderExecutionLifecycleRegistry } from '@/core/execution';
import type { ChatMessage } from '@/core/types';
import { StreamController } from '@/features/chat/controllers/StreamController';
import { ChatExecutionCoordinator } from '@/features/chat/execution/ChatExecutionCoordinator';
import { MessageRenderer } from '@/features/chat/rendering/MessageRenderer';
import { SubagentManager } from '@/features/chat/services/SubagentManager';
import { ChatState } from '@/features/chat/state/ChatState';
import { TabSession } from '@/features/chat/tabs/TabSession';
import { enqueueTabSessionEvent } from '@/features/chat/tabs/TabSessionEvents';
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
  jest.mocked(fs.readFile).mockResolvedValue(entries.map((entry, index) => JSON.stringify({ timestamp: new Date(1000 + index * 1000).toISOString(), ...entry })).join('\n'));
  const replay = await loadSDKSessionMessages('/vault', 'session', undefined, '/session.jsonl');
  expect(replay.error).toBeUndefined();
  const messagesEl = document.body.createDiv();
  const renderer = new MessageRenderer({ app: {}, settings: { mediaFolder: '', showMessageTimestamps: false } } as any, { registerDomEvent: jest.fn(), register: jest.fn(), addChild: jest.fn() } as any, messagesEl);
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

it.each([false, true])('keeps main-chat automatic work and later output on either side of a notification (compaction: %s)', async (compaction) => {
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
    const requested: ChatMessage = { id: 'requested', role: 'assistant', timestamp: 1, content: '', contentBlocks: [] };
    state.addMessage(requested);
    state.currentContentEl = renderer.addMessage(requested).querySelector('.claudian-message-content');
    await stream.handleStreamChunk({ type: 'text', content: 'Requested ' }, requested);
    const current = state.currentContentEl;
    const native = backend.latest;
    native.emitSessionEvent({ type: 'task_notification', content: 'First task finished.' });
    native.emitBackgroundEvent({ type: 'background_turn_started' });
    native.emitBackgroundEvent({ type: 'tool_started', toolCallId: 'read', toolScope: { kind: 'main' }, name: 'Read', input: { file_path: 'task.output' } });
    native.emitBackgroundEvent({ type: 'tool_completed', toolCallId: 'read', toolScope: { kind: 'main' }, content: 'First task result' });
    native.emitSessionEvent({ type: 'task_notification', content: 'Second task finished.' });
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
    const output = [notification, ...(compaction ? [within(messagesEl).getByText('Conversation compacted')] : []), answer];
    for (const [index, element] of output.slice(1).entries()) {
      expect(output[index].compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
    expect(state.messages.at(-1)).toMatchObject({ content: 'After notification.', assistantMessageId: 'final-checkpoint', isAutomaticResponse: true });
    expect(state.messages.filter(message => message.assistantMessageId === 'final-checkpoint')).toHaveLength(1);
    expect(state.currentContentEl).toBe(current);
    await stream.handleStreamChunk({ type: 'text', content: 'answer' }, requested);
    await stream.finalizeCurrentTextBlock(requested);
    expect(requested.content).toBe('Requested answer');
    expect((await axe(messagesEl)).violations).toEqual([]);
  } finally {
    await coordinator.dispose();
    await lifecycleRegistry.dispose();
    stream.dispose(); subagents.clear(); renderer.dispose();
  }
});
